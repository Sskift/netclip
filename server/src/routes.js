import { networkInterfaces } from 'node:os'
import { existsSync } from 'node:fs'
import { config } from './config.js'
import * as store from './db.js'
import { blobPath, thumbPath } from './blobs.js'
import * as items from './items.js'
import { subscribe, clientCount } from './events.js'
import { HttpError, json, noContent, readBody, sendBuffer, sendFile } from './http.js'
import { deviceLabel } from './device.js'

const IMMUTABLE = 'public, max-age=31536000, immutable'

/**
 * Blobs are only ever served back as one of these. Anything else — including anything a
 * client mislabelled on the way in — becomes an opaque download rather than something the
 * browser might decide to execute in our own origin.
 */
const SERVABLE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
])
const servableType = (mime) => (SERVABLE.has(mime) ? mime : 'application/octet-stream')

/**
 * Best-effort LAN address, used only as a fallback when the app is opened on localhost —
 * every other time, the browser's own address bar is the answer and this is ignored.
 */
function lanAddresses() {
  const out = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/^(lo|docker|br-|veth|virbr|tun|tap|utun|awdl|llw)/i.test(name)) continue
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address)
    }
  }
  // 192.168.* and 10.* are the ones a phone is most likely to reach.
  return out.sort((a, b) => rank(a) - rank(b))
}

const inContainer = existsSync('/.dockerenv')
const DOCKER_BRIDGE_POOL = /^172\.(1[6-9]|2\d|3[01])\./

/**
 * Whether the addresses above are worth showing anyone.
 *
 * A bridge-networked container sees only its own address on Docker's private bridge —
 * something like 172.19.0.2, which no phone can reach. Encoding that into a QR code
 * produces a code that scans fine and then fails to connect, which is the worst kind of
 * wrong. When we can tell that's what we're looking at, say so instead.
 */
const lanLooksReachable = (addrs) =>
  addrs.length > 0 && !(inContainer && addrs.every((ip) => DOCKER_BRIDGE_POOL.test(ip)))
const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2)

const clampInt = (v, def, min, max) => {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
}

const mimeOf = (req) => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()

const headerFilename = (req) => {
  const raw = req.headers['x-filename']
  if (!raw) return null
  try {
    return decodeURIComponent(String(raw))
  } catch {
    return String(raw)
  }
}

/**
 * Bytes that decode as clean UTF-8 are kept as a text item, so dropping a .md / .csv /
 * .json file does something useful instead of erroring. Anything with binary control
 * bytes is rejected as an unsupported file type.
 */
function asTextIfPossible(buf) {
  const text = buf.toString('utf8')
  if (text.includes('�')) return null // invalid UTF-8 sequence → binary
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const printable = c >= 0x20 ? c !== 0x7f : c === 0x09 || c === 0x0a || c === 0x0d
    if (!printable) return null
  }
  return text
}

export async function handleApi(req, res, url) {
  const { pathname, searchParams } = url
  const method = req.method === 'HEAD' ? 'GET' : req.method

  if (pathname === '/api/events' && method === 'GET') {
    return subscribe(req, res)
  }

  if (pathname === '/api/health') {
    return json(res, 200, { ok: true })
  }

  if (pathname === '/api/info' && method === 'GET') {
    const stats = store.getStats()
    const lan = lanAddresses()
    return json(res, 200, {
      retentionDays: Math.round(config.retention.text / 86_400_000),
      imageRetentionDays: Math.round(config.retention.image / 86_400_000),
      maxUploadBytes: config.maxUploadBytes,
      maxTextBytes: config.maxTextBytes,
      maxItems: config.maxItems,
      port: config.port,
      lanAddresses: lan,
      lanReachable: lanLooksReachable(lan),
      device: deviceLabel(req),
      connectedClients: clientCount(),
      stats: { total: stats.total, pinned: stats.pinned, bytes: stats.bytes },
    })
  }

  /* ------------------------------------------------------------- collection */

  if (pathname === '/api/items') {
    if (method === 'GET') {
      const rows = store.listItems({
        query: searchParams.get('q') || '',
        // The default has to clear maxItems (500) plus however many pins exist, or the
        // oldest retained items would simply never appear in the UI.
        limit: clampInt(searchParams.get('limit'), 1000, 1, 1000),
        offset: clampInt(searchParams.get('offset'), 0, 0, 1e6),
      })
      return json(res, 200, { items: items.applyInlineBudget(rows.map(items.toDTO)) })
    }

    // PUT as well as POST, because `curl -T` — by far the nicest way to pipe something in
    // from a shell — sends PUT, and a documented recipe that 405s is worse than useless.
    if (method === 'POST' || method === 'PUT') {
      const source = deviceLabel(req)
      const body = await readBody(req, config.maxTextBytes)
      let text
      if (mimeOf(req) === 'application/json') {
        let parsed
        try {
          parsed = JSON.parse(body.toString('utf8') || '{}')
        } catch {
          throw new HttpError(400, 'Body was not valid JSON.')
        }
        text = parsed.text ?? parsed.content
        if (typeof text !== 'string') throw new HttpError(400, 'Expected {"text": "..."}.')
      } else {
        text = body.toString('utf8')
      }
      const { item, created } = await items.addText(text, { source })
      return json(res, created ? 201 : 200, { item: items.toDTO(item), created })
    }

    if (method === 'DELETE') {
      const removed = await items.clearUnpinned()
      return json(res, 200, { removed })
    }

    throw new HttpError(405, 'Method not allowed')
  }

  /* ------------------------------------------------------------ file upload */

  if (pathname === '/api/items/file' && (method === 'POST' || method === 'PUT')) {
    const source = deviceLabel(req)
    const mime = mimeOf(req)
    const filename = headerFilename(req)
    const buf = await readBody(req, config.maxUploadBytes)

    if (mime.startsWith('image/')) {
      const { item, created } = await items.addImage(buf, { mime, filename, source })
      return json(res, created ? 201 : 200, { item: items.toDTO(item), created })
    }

    if (buf.length <= config.maxTextBytes) {
      const text = asTextIfPossible(buf)
      if (text !== null) {
        const { item, created } = await items.addText(text, { source })
        return json(res, created ? 201 : 200, { item: items.toDTO(item), created })
      }
    }
    throw new HttpError(415, 'Only images and text are supported right now.')
  }

  /* --------------------------------------------------------------- one item */

  const m = /^\/api\/items\/(\d+)(?:\/(raw|thumb|copy))?$/.exec(pathname)
  if (m) {
    const id = Number(m[1])
    const variant = m[2]

    // Deleting something that is already gone is a success, not a 404 — two devices can
    // both delete the same row, and the second one should not see an error.
    if (method === 'DELETE' && !variant) {
      await items.remove(id)
      return noContent(res)
    }

    const row = store.getItem(id)
    if (!row) throw new HttpError(404, 'Not found')

    // Fired after a copy lands, never before — it must not sit in the user gesture's path.
    if (variant === 'copy') {
      if (method !== 'POST') throw new HttpError(405, 'Method not allowed')
      return json(res, 200, { item: items.toDTO(items.countCopy(id)) })
    }

    if (variant) {
      // Text downloads go through the server too, so the browser writes the real body —
      // the client only ever holds the full content for items small enough to be inlined,
      // and building the file client-side would silently save a truncated preview.
      if (row.kind === 'text') {
        if (variant === 'thumb') throw new HttpError(404, 'Not an image')
        return sendBuffer(req, res, Buffer.from(row.content ?? '', 'utf8'), {
          contentType: 'text/plain; charset=utf-8',
          cacheControl: IMMUTABLE,
          filename: `netclip-${row.id}.txt`,
          inline: searchParams.get('download') !== '1',
        })
      }
      const wantThumb = variant === 'thumb' && row.has_thumb
      const ok = await sendFile(req, res, wantThumb ? thumbPath(row.hash) : blobPath(row.hash), {
        contentType: wantThumb ? 'image/webp' : servableType(row.mime),
        cacheControl: IMMUTABLE,
        filename: row.filename || `netclip-${row.id}`,
        inline: searchParams.get('download') !== '1',
        // Blobs are inert data. Never let one be sniffed into something executable.
        headers: { 'X-Content-Type-Options': 'nosniff' },
      })
      if (!ok) throw new HttpError(404, 'File is gone')
      return
    }

    if (method === 'GET') return json(res, 200, { item: items.withContent(row) })

    if (method === 'PATCH') {
      const body = await readBody(req, 4096)
      let patch = {}
      try {
        patch = JSON.parse(body.toString('utf8') || '{}')
      } catch {
        throw new HttpError(400, 'Body was not valid JSON.')
      }
      if (typeof patch.pinned !== 'boolean') throw new HttpError(400, 'Expected {"pinned": true|false}.')
      return json(res, 200, { item: items.toDTO(items.pin(id, patch.pinned)) })
    }

    throw new HttpError(405, 'Method not allowed')
  }

  throw new HttpError(404, 'No such endpoint')
}
