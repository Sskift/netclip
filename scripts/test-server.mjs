#!/usr/bin/env node
/**
 * Server behaviour tests. Run against a live instance:
 *
 *   node scripts/test-server.mjs [baseUrl]
 *
 * These cover the things that are easy to break silently and impossible to notice by
 * clicking around: search folding, the ingest sanitiser, dedupe, lease renewal, EXIF
 * orientation, and the inline-content threshold that mobile copy depends on.
 */
import sharp from 'sharp'

const BASE = process.argv[2] || 'http://127.0.0.1:3210'

const failures = []
const passes = []
const check = (label, ok, detail = '') => {
  if (ok) passes.push(`  ok    ${label}`)
  else failures.push(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}

const api = async (path, init) => {
  const res = await fetch(BASE + path, init)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, headers: res.headers }
}

const postText = (text) =>
  api('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })

const postFile = (buf, mime, filename) =>
  api('/api/items/file', {
    method: 'POST',
    headers: { 'content-type': mime, ...(filename ? { 'x-filename': filename } : {}) },
    body: buf,
  })

const list = (q = '') => api(`/api/items?q=${encodeURIComponent(q)}`).then((r) => r.body.items)

/* ------------------------------------------------------------------ setup */

/**
 * This suite unpins and deletes everything, so it must never be pointed at an instance
 * somebody is actually using — and "somebody is actually using it" is exactly what a
 * non-empty list means. The default port is the same one a real deployment listens on, so
 * this guard is the only thing standing between a stray `npm test` and someone's history.
 */
const existing = await list()
if (existing.length && !process.argv.includes('--force')) {
  console.error(`\nREFUSING TO RUN: ${BASE} already has ${existing.length} item(s).`)
  console.error('This suite deletes everything, including pins. It only runs against an empty instance.\n')
  console.error('  · point it at a scratch server:  node scripts/test-server.mjs http://127.0.0.1:3299')
  console.error('  · or, if you are certain this instance is disposable:  --force\n')
  process.exit(2)
}

// Clearing spares pinned rows by design, so unpin anything a previous run left behind.
for (const item of existing) {
  if (item.pinned) {
    await api(`/api/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: false }),
    })
  }
}
await api('/api/items', { method: 'DELETE' })

/* ---------------------------------------------------------------- search */

await postText('Docker Compose UP')
await postText('Дорогой Иван, спасибо')
await postText('你好世界 clipboard 测试')

const fullwidth = [...'docker'].map((c) => String.fromCharCode(c.charCodeAt(0) - 0x61 + 0xff41)).join('')
check('NFKC folding: a full-width query matches half-width content', (await list(fullwidth)).length === 1)
check('case folding works beyond ASCII (Cyrillic)', (await list('дорогой')).length === 1)
check('CJK substring search', (await list('世界')).length === 1)
check('two-character CJK query works (FTS5 trigram would return nothing here)', (await list('测试')).length === 1)
check('LIKE metacharacters are escaped, not interpreted', (await list('%')).length === 0)

/* -------------------------------------------------------------- ingest */

const NUL = String.fromCharCode(0)
const BEL = String.fromCharCode(7)
const LSEP = String.fromCharCode(0x2028)
const RLO = String.fromCharCode(0x202e)

const dirty = await postText(`clean${NUL} text${BEL} here${LSEP} end`)
check('C0 controls and line separators are stripped before storage', dirty.body.item.content === 'clean text here end')

const bidi = await postText(`invoice${RLO} gnp.exe`)
check('a bidi override is neutralised in the preview', bidi.body.item.preview.includes('⚑'))
check('...but preserved verbatim in the stored content', bidi.body.item.content.includes(RLO))

check('empty text is rejected', (await postText('   \n  ')).status === 400)
check('a URL is detected as a link', (await postText('https://example.com/a/b')).body.item.flavor === 'url')
check('JSON is detected', (await postText('{"a":[1,2,3]}')).body.item.flavor === 'json')

/* --------------------------------------------------------------- dedupe */

const first = await postText('a duplicated clip')
const again = await postText('a duplicated clip')
check('identical text bumps instead of duplicating', again.body.created === false && again.body.item.id === first.body.item.id)
check('the bump moves it back to the top', (await list())[0].id === first.body.item.id)
check('the bump renews the lease', again.body.item.expiresAt > first.body.item.expiresAt)

/* ---------------------------------------------------------------- lease */

const target = (await list())[0]
const copied = await api(`/api/items/${target.id}/copy`, { method: 'POST' })
check('copying counts the use', copied.body.item.copyCount === 1)
check('copying renews the lease', copied.body.item.expiresAt > target.expiresAt)
check('copying does NOT reorder the list', copied.body.item.updatedAt === target.updatedAt)

const pinned = await api(`/api/items/${target.id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pinned: true }),
})
check('pinning removes the lease entirely', pinned.body.item.expiresAt === null)
check('pinned items sort first', (await list())[0].pinned === true)

const unpinned = await api(`/api/items/${target.id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pinned: false }),
})
check(
  'unpinning grants a fresh full lease rather than an expired one',
  unpinned.body.item.expiresAt > Date.now() + 6 * 86_400_000,
)
check('unpinning does not reorder the list', unpinned.body.item.updatedAt === target.updatedAt)

/* --------------------------------------------------------------- images */

const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 30, g: 120, b: 200 } } })
  .png()
  .toBuffer()
const shot = await postFile(png, 'image/png', 'shot.png')
check('an image stores its dimensions', shot.body.item.width === 900 && shot.body.item.height === 600)
check('an image gets an average colour for the loading placeholder', /^#[0-9a-f]{6}$/.test(shot.body.item.color))
check('an image gets a thumbnail', shot.body.item.hasThumb === true)

const thumb = await fetch(`${BASE}/api/items/${shot.body.item.id}/thumb`)
check('the thumbnail is served as webp', thumb.headers.get('content-type') === 'image/webp')
const thumbBytes = (await thumb.arrayBuffer()).byteLength
check('the thumbnail is much smaller than the original', thumbBytes < png.length / 4, `${thumbBytes}B vs ${png.length}B`)

const raw = await fetch(`${BASE}/api/items/${shot.body.item.id}/raw`)
check('the raw blob is served with nosniff', raw.headers.get('x-content-type-options') === 'nosniff')
check('the raw blob is immutable-cacheable', /immutable/.test(raw.headers.get('cache-control') || ''))

// EXIF orientation 6 means the stored pixels are a quarter-turn from how they display.
// The reported dimensions must match what the browser paints, or the CSS aspect-ratio
// placeholder visibly jumps when the image loads.
const rotated = await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 40, g: 90, b: 180 } } })
  .withMetadata({ orientation: 6 })
  .jpeg()
  .toBuffer()
const rot = await postFile(rotated, 'image/jpeg', 'rotated.jpg')
check(
  'EXIF orientation is applied to the reported dimensions',
  rot.body.item.width === 200 && rot.body.item.height === 400,
  `${rot.body.item.width}x${rot.body.item.height}`,
)

const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
check('SVG is rejected by magic bytes even when labelled image/png', (await postFile(svg, 'image/png', 'x.png')).status === 415)

const sameImage = await postFile(png, 'image/png', 'shot-again.png')
check('an identical image bumps instead of duplicating', sameImage.body.created === false)

/* ------------------------------------------------- inline content contract */

const small = await postText('x'.repeat(1000))
const big = await postText('y'.repeat(40_000))
const rows = await list()
const smallRow = rows.find((r) => r.id === small.body.item.id)
const bigRow = rows.find((r) => r.id === big.body.item.id)
check('small text ships inline so copy can be synchronous', smallRow.content?.length === 1000)
check('large text is marked truncated instead', bigRow.truncated === true && bigRow.content == null)
const bigFull = await api(`/api/items/${big.body.item.id}`)
check('...and the single-item read always carries the full body', bigFull.body.item.content.length === 40_000)

// Downloading text goes through the server precisely because the client does not hold the
// full body of a truncated item — building the file locally would save the 300-char preview.
const bigDownload = await fetch(`${BASE}/api/items/${big.body.item.id}/raw?download=1`)
const bigDownloadText = await bigDownload.text()
check('a text download serves the FULL body, not the preview', bigDownloadText.length === 40_000, `${bigDownloadText.length} chars`)
check('...as an attachment', /attachment/.test(bigDownload.headers.get('content-disposition') || ''))
check('...as text/plain', /text\/plain/.test(bigDownload.headers.get('content-type') || ''))
check('a text item has no thumbnail endpoint', (await api(`/api/items/${big.body.item.id}/thumb`)).status === 404)

/* --------------------------------------------- concurrent identical uploads */

// Both requests pass the "does this hash exist" check before either inserts; the unique
// index catches the loser. That is a dedupe, not a 500.
const racers = await Promise.all(Array.from({ length: 6 }, () => postText('a simultaneously pasted clip')))
check('concurrent identical text never 500s', racers.every((r) => r.status < 400), racers.map((r) => r.status).join(','))
const ids = new Set(racers.map((r) => r.body.item.id))
check('...and they all resolve to one item', ids.size === 1, `${ids.size} distinct ids`)

const racePng = await sharp({ create: { width: 120, height: 120, channels: 3, background: { r: 9, g: 9, b: 9 } } })
  .png()
  .toBuffer()
const imageRacers = await Promise.all(Array.from({ length: 4 }, () => postFile(racePng, 'image/png', 'race.png')))
check('concurrent identical images never 500', imageRacers.every((r) => r.status < 400), imageRacers.map((r) => r.status).join(','))
check('...and they all resolve to one item', new Set(imageRacers.map((r) => r.body.item.id)).size === 1)

/* ------------------------------------------------------- streaming hygiene */

// A bare .pipe() would leak the file descriptor on every one of these aborts.
const shotId = shot.body.item.id
for (let i = 0; i < 25; i++) {
  const controller = new AbortController()
  fetch(`${BASE}/api/items/${shotId}/raw`, { signal: controller.signal }).catch(() => {})
  await new Promise((r) => setTimeout(r, 4))
  controller.abort()
}
await new Promise((r) => setTimeout(r, 300))
check('the server survives 25 aborted blob downloads', (await api('/api/health')).status === 200)
check('...and still serves that blob afterwards', (await fetch(`${BASE}/api/items/${shotId}/raw`)).status === 200)

check('oversized text is refused with a readable message', (await postText('z'.repeat(2 * 1024 * 1024))).status === 413)

/* ------------------------------------------------------------ misc rules */

check('deleting a nonexistent id is a success, not a 404', (await api('/api/items/999999', { method: 'DELETE' })).status === 204)

// `curl -T` sends PUT. The README documents that recipe, so it has to work.
const viaPut = await api('/api/items', {
  method: 'PUT',
  headers: { 'content-type': 'text/plain' },
  body: 'sent with curl -T style PUT',
})
check('PUT /api/items works (curl -T)', viaPut.status < 400 && viaPut.body.item.content === 'sent with curl -T style PUT', String(viaPut.status))

const info = (await api('/api/info')).body
check('/api/info reports the text retention', info.retentionDays === 7, String(info.retentionDays))
check('/api/info reports the image retention', info.imageRetentionDays === 3, String(info.imageRetentionDays))
check('/api/info reports a LAN address for the QR fallback', Array.isArray(info.lanAddresses))

// The list default must clear maxItems, or the oldest retained rows are simply invisible.
check('the list default limit is at least maxItems', info.maxItems <= 1000)

const beforeClear = await list()
const stillPinned = beforeClear.filter((r) => r.pinned).length
await api(`/api/items/${beforeClear[beforeClear.length - 1].id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ pinned: true }),
})
await api('/api/items', { method: 'DELETE' })
const afterClear = await list()
check('clearing keeps pinned items', afterClear.length === stillPinned + 1 && afterClear.every((r) => r.pinned))

/* ---------------------------------------------------------------- cleanup */

// Leave the instance as we found it — empty. The UI suite runs next against the same
// server and its own guard (rightly) refuses to touch anything that already has content.
for (const item of await list()) {
  if (item.pinned) {
    await api(`/api/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: false }),
    })
  }
}
await api('/api/items', { method: 'DELETE' })
check('the suite leaves the instance empty for the next one', (await list()).length === 0)

/* ----------------------------------------------------------------- report */

for (const line of passes) console.log(line)
if (failures.length) {
  console.log('')
  for (const line of failures) console.log(line)
  console.log(`\n${failures.length} failure(s), ${passes.length} passed.\n`)
  process.exit(1)
}
console.log(`\nall ${passes.length} server checks passed.\n`)
