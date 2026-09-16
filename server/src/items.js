import { config, ttlFor } from './config.js'
import * as store from './db.js'
import { analyseImage, dropBlob, putBlob, sha256 } from './blobs.js'
import { broadcast } from './events.js'
import { HttpError, fmtBytes } from './http.js'

const now = () => Date.now()
const leaseFor = (kind, t = now()) => t + ttlFor(kind)

/* ------------------------------------------------------------------ shaping */

/** What the client sees. Full `content` only rides along when it is small enough. */
export function toDTO(row) {
  if (!row) return null
  const dto = {
    id: row.id,
    kind: row.kind,
    preview: row.preview,
    bytes: row.bytes,
    source: row.source,
    pinned: !!row.pinned,
    copyCount: row.copy_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  }
  if (row.kind === 'text') {
    dto.flavor = row.flavor || 'text'
    dto.lines = row.lines
    if (row.bytes <= config.inlineTextBytes && row.content != null) dto.content = row.content
    else dto.truncated = true
  } else {
    dto.mime = row.mime
    dto.filename = row.filename
    dto.width = row.width
    dto.height = row.height
    dto.color = row.color
    dto.hasThumb = !!row.has_thumb
  }
  return dto
}

export const withContent = (row) => (row ? { ...toDTO(row), content: row.content ?? null } : null)

/**
 * Caps how much text one list response may inline, newest-first. Rows that miss the budget
 * are marked truncated and fetched individually when selected.
 */
export function applyInlineBudget(dtos) {
  let budget = config.inlineBudgetBytes
  for (const dto of dtos) {
    if (dto.content == null) continue
    if (dto.bytes <= budget) {
      budget -= dto.bytes
      continue
    }
    delete dto.content
    dto.truncated = true
  }
  return dtos
}

/**
 * Insert, but treat a unique-hash collision as the dedupe it actually is.
 *
 * The getItemByHash check and the insert straddle an await, so two devices pasting the
 * same thing at the same moment can both pass the check before either writes. The unique
 * index catches the loser — which means "someone else just saved this", not an error.
 */
function insertOrBump(row, { at, kind, source }) {
  try {
    const item = store.insertItem(row)
    broadcast('created', toDTO(item))
    return { item, created: true }
  } catch (err) {
    if (!/UNIQUE|constraint/i.test(String(err?.message ?? ''))) throw err
    const existing = store.getItemByHash(row.hash)
    if (!existing) throw err
    const bumped = store.bumpItem(existing.id, { now: at, expiresAt: leaseFor(kind, at), source })
    broadcast('updated', toDTO(bumped))
    return { item: bumped, created: false }
  }
}

/* -------------------------------------------------------------- text intake */

// C0 controls except tab/newline/carriage-return, DEL, and the two line separators that
// break JSON consumers. Stripped before hashing, so the hash always describes what we stored.
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u2028\\u2029]', 'g')
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

export const sanitiseText = (input) =>
  String(input).replace(CONTROL, '').replace(LONE_SURROGATE, '�')

const URL_RE = /^(https?:\/\/|www\.)[^\s]+$/i
const COLOR_RE = /^#[0-9a-f]{3,8}$|^rgba?\([\d\s.,%/]+\)$|^hsla?\([\d\s.,%/]+\)$/i

function flavorOf(text) {
  const t = text.trim()
  if (!t.includes('\n')) {
    if (URL_RE.test(t)) return 'url'
    if (COLOR_RE.test(t)) return 'color'
  }
  if (t.length < 512 * 1024 && /^[[{]/.test(t) && /[\]}]$/.test(t)) {
    try {
      JSON.parse(t)
      return 'json'
    } catch {
      /* not json */
    }
  }
  return 'text'
}

// Bidi overrides let text render in an order that isn't the order it will paste in. Kept
// intact in the stored content; neutralised in the preview so a list row can't lie.
const BIDI = new RegExp('[\\u202A-\\u202E\\u2066-\\u2069]', 'g')

const segmenter =
  typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/** Truncates on grapheme clusters so an emoji or a Devanagari cluster is never cut in half. */
function previewOf(text) {
  const flat = text.replace(BIDI, '⚑').replace(/\s+/g, ' ').trim()
  if (flat.length <= config.previewChars) return flat
  if (!segmenter) return flat.slice(0, config.previewChars)
  let out = ''
  let n = 0
  for (const { segment } of segmenter.segment(flat)) {
    if (++n > config.previewChars) break
    out += segment
  }
  return out
}

export async function addText(content, { source = '' } = {}) {
  const text = sanitiseText(content)
  if (!text.trim()) throw new HttpError(400, 'Nothing to save — that was empty.')

  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > config.maxTextBytes) {
    throw new HttpError(413, `Text is ${fmtBytes(bytes)}; the limit is ${fmtBytes(config.maxTextBytes)}.`)
  }

  // Domain-separated so a text payload can never collide with an image payload.
  const hash = sha256(Buffer.from('text:' + text, 'utf8'))
  const t = now()

  const existing = store.getItemByHash(hash)
  if (existing) {
    const bumped = store.bumpItem(existing.id, { now: t, expiresAt: leaseFor('text', t), source })
    broadcast('updated', toDTO(bumped))
    return { item: bumped, created: false }
  }

  return insertOrBump(
    {
      kind: 'text',
      content: text,
      search_text: store.fold(text),
      preview: previewOf(text),
      hash,
      bytes,
      flavor: flavorOf(text),
      lines: text.split('\n').length,
      source,
      created_at: t,
      updated_at: t,
      expires_at: leaseFor('text', t),
    },
    { at: t, kind: 'text', source },
  )
}

/* ------------------------------------------------------------- image intake */

const cleanFilename = (name) => {
  if (!name) return null
  return String(name).replace(/[/\\]/g, '_').replace(new RegExp('[\\u0000-\\u001F\\u007F]', 'g'), '').trim().slice(0, 120) || null
}

/**
 * SVG is an active document, not a picture — served from our own origin it would run as
 * us. Detected by content, because the declared MIME and the filename are both attacker
 * -chosen. This is the one content check worth keeping in a tool with no auth.
 */
function looksLikeSvg(buf) {
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase()
  return head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!doctype svg')
}

export async function addImage(buf, { mime, filename, source = '' } = {}) {
  if (!buf?.length) throw new HttpError(400, 'Nothing to save — the file was empty.')
  if (buf.length > config.maxUploadBytes) {
    throw new HttpError(413, `File is ${fmtBytes(buf.length)}; the limit is ${fmtBytes(config.maxUploadBytes)}.`)
  }
  if (looksLikeSvg(buf)) throw new HttpError(415, 'SVG isn’t supported — send a PNG or JPEG instead.')

  const hash = sha256(buf)
  const t = now()

  const existing = store.getItemByHash(hash)
  if (existing) {
    const bumped = store.bumpItem(existing.id, { now: t, expiresAt: leaseFor('image', t), source })
    broadcast('updated', toDTO(bumped))
    return { item: bumped, created: false }
  }

  const analysis = await analyseImage(hash, buf)
  await putBlob(hash, buf)
  const name = cleanFilename(filename)

  return insertOrBump(
    {
      kind: 'image',
      search_text: store.fold(name || ''),
      preview: name || 'Image',
      hash,
      bytes: buf.length,
      mime: mime || 'application/octet-stream',
      filename: name,
      ...analysis,
      source,
      created_at: t,
      updated_at: t,
      expires_at: leaseFor('image', t),
    },
    { at: t, kind: 'image', source },
  )
}

/* ------------------------------------------------------------------ mutation */

export function pin(id, pinned) {
  const t = now()
  const existing = store.getItem(id)
  if (!existing) throw new HttpError(404, 'Not found')
  const row = store.setPinned(id, pinned, { now: t, expiresAt: leaseFor(existing.kind, t) })
  broadcast('updated', toDTO(row))
  return row
}

/** Called after a successful copy: renews the lease so things you use don't age out. */
export function countCopy(id) {
  const existing = store.getItem(id)
  if (!existing) throw new HttpError(404, 'Not found')
  const row = store.countCopy(id, leaseFor(existing.kind))
  broadcast('updated', toDTO(row))
  return row
}

export async function remove(id) {
  const row = store.getItem(id)
  if (!row) return false // deleting something already gone is a success, not an error
  store.deleteItem(id)
  if (row.kind === 'image') await dropBlob(row.hash)
  broadcast('deleted', { id })
  return true
}

/** Clears everything that isn't pinned. Pins are the user's explicit "keep this". */
export async function clearUnpinned() {
  const rows = store.listAllUnpinned()
  for (const row of rows) {
    store.deleteItem(row.id)
    if (row.kind === 'image') await dropBlob(row.hash)
  }
  if (rows.length) broadcast('purged', { ids: rows.map((r) => r.id) })
  return rows.length
}
