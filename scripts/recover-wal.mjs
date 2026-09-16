#!/usr/bin/env node
/**
 * Salvages `items` rows out of a SQLite write-ahead log.
 *
 * A committed DELETE only unlinks the row from the b-tree; the page images written to the
 * WAL *before* the delete still contain the records verbatim until a checkpoint overwrites
 * them. This walks every frame in the WAL, parses each table-leaf page it finds, and
 * reconstructs any record whose shape matches the items table.
 *
 *   node scripts/recover-wal.mjs <dataDir> [--json out.json]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = process.argv[2]
if (!dataDir) {
  console.error('usage: node scripts/recover-wal.mjs <dataDir> [--json out.json]')
  process.exit(1)
}
const jsonFlag = process.argv.indexOf('--json')
const jsonOut = jsonFlag > -1 ? process.argv[jsonFlag + 1] : null

/* ------------------------------------------------------------------ varint */

function varint(buf, offset) {
  let value = 0n
  for (let i = 0; i < 9; i++) {
    const byte = buf[offset + i]
    if (byte === undefined) return null
    if (i === 8) {
      value = (value << 8n) | BigInt(byte)
      return [value, i + 1]
    }
    value = (value << 7n) | BigInt(byte & 0x7f)
    if (!(byte & 0x80)) return [value, i + 1]
  }
  return null
}

/* ------------------------------------------------- serial types -> values */

function serialSize(type) {
  if (type === 0 || type === 8 || type === 9) return 0
  if (type <= 4) return type
  if (type === 5) return 6
  if (type === 6 || type === 7) return 8
  if (type >= 12) return Math.floor((type - 12) / 2)
  return 0
}

function readValue(buf, offset, type) {
  const size = serialSize(type)
  if (offset + size > buf.length) return { value: undefined, size, short: true }
  if (type === 0) return { value: null, size }
  if (type === 8) return { value: 0, size }
  if (type === 9) return { value: 1, size }
  if (type >= 1 && type <= 6) {
    let n = 0n
    for (let i = 0; i < size; i++) n = (n << 8n) | BigInt(buf[offset + i])
    // sign-extend
    const bits = BigInt(size * 8)
    if (n >= 1n << (bits - 1n)) n -= 1n << bits
    return { value: Number(n), size }
  }
  if (type === 7) return { value: buf.readDoubleBE(offset), size }
  const slice = buf.subarray(offset, offset + size)
  if (type % 2 === 1) return { value: slice.toString('utf8'), size } // TEXT
  return { value: slice, size } // BLOB
}

/* ------------------------------------------------------------- WAL frames */

function readWal(path) {
  // A cleanly shut down database has already checkpointed and removed its WAL; in that
  // case the only place left to look is the main file's freed pages.
  if (!existsSync(path)) {
    console.log('  (no WAL present — scanning the database file only)')
    return { pageSize: 0, frames: [] }
  }
  const buf = readFileSync(path)
  if (buf.length < 32) return { pageSize: 0, frames: [] }
  const magic = buf.readUInt32BE(0)
  if (magic !== 0x377f0682 && magic !== 0x377f0683) {
    console.error(`  warning: ${path} does not look like a WAL (magic ${magic.toString(16)})`)
  }
  const pageSize = buf.readUInt32BE(8)
  const frames = []
  let at = 32
  while (at + 24 + pageSize <= buf.length) {
    const pgno = buf.readUInt32BE(at)
    frames.push({ pgno, page: buf.subarray(at + 24, at + 24 + pageSize) })
    at += 24 + pageSize
  }
  return { pageSize, frames }
}

function readDbPages(path, pageSize) {
  const buf = readFileSync(path)
  const size = pageSize || buf.readUInt16BE(16) || 4096
  const real = size === 1 ? 65536 : size
  const pages = []
  for (let i = 0; i * real < buf.length; i++) {
    pages.push({ pgno: i + 1, page: buf.subarray(i * real, (i + 1) * real) })
  }
  return pages
}

/* ---------------------------------------------------------- page decoding */

// items: id, kind, content, search_text, preview, hash, bytes, mime, filename, width,
//        height, color, has_thumb, flavor, lines, source, pinned, copy_count,
//        created_at, updated_at, expires_at
const COLUMNS = [
  'id', 'kind', 'content', 'search_text', 'preview', 'hash', 'bytes', 'mime', 'filename',
  'width', 'height', 'color', 'has_thumb', 'flavor', 'lines', 'source', 'pinned',
  'copy_count', 'created_at', 'updated_at', 'expires_at',
]

function parseLeafPage(page, pgno, overflowLookup) {
  // Page 1 carries the 100-byte file header before the b-tree header.
  const base = pgno === 1 ? 100 : 0
  if (page[base] !== 0x0d) return [] // not a table-leaf page
  const cellCount = page.readUInt16BE(base + 3)
  if (!cellCount || cellCount > 1000) return []

  const rows = []
  for (let i = 0; i < cellCount; i++) {
    const ptrAt = base + 8 + i * 2
    if (ptrAt + 2 > page.length) break
    const cellStart = page.readUInt16BE(ptrAt)
    if (cellStart < base || cellStart >= page.length) continue
    try {
      const row = parseCell(page, cellStart, overflowLookup)
      if (row) rows.push(row)
    } catch {
      /* torn or unrelated page */
    }
  }
  return rows
}

function parseCell(page, at, overflowLookup) {
  let cursor = at
  const payloadLen = varint(page, cursor)
  if (!payloadLen) return null
  cursor += payloadLen[1]
  const rowid = varint(page, cursor)
  if (!rowid) return null
  cursor += rowid[1]

  const total = Number(payloadLen[0])
  if (total <= 0 || total > 50_000_000) return null

  // How much of the payload lives on this page (SQLite's local-payload formula).
  const usable = page.length
  const maxLocal = usable - 35
  const minLocal = ((usable - 12) * 32) / 255 - 23
  let local = total
  if (total > maxLocal) {
    local = Math.floor(minLocal + ((total - minLocal) % (usable - 4)))
    if (local > maxLocal) local = Math.floor(minLocal)
  }

  let payload = page.subarray(cursor, cursor + local)

  if (total > local) {
    // The rest lives in a chain of overflow pages; the first is named after the payload.
    const nextAt = cursor + local
    if (nextAt + 4 <= page.length) {
      let next = page.readUInt32BE(nextAt)
      const chunks = [payload]
      let remaining = total - local
      const seen = new Set()
      while (next && remaining > 0 && !seen.has(next)) {
        seen.add(next)
        const ovf = overflowLookup(next)
        if (!ovf) break
        const take = Math.min(remaining, ovf.length - 4)
        chunks.push(ovf.subarray(4, 4 + take))
        remaining -= take
        next = ovf.readUInt32BE(0)
      }
      payload = Buffer.concat(chunks)
    }
  }

  return decodeRecord(payload, Number(rowid[0]))
}

function decodeRecord(payload, rowid) {
  const headerLen = varint(payload, 0)
  if (!headerLen) return null
  const headerSize = Number(headerLen[0])
  if (headerSize < 2 || headerSize > payload.length) return null

  const types = []
  let cursor = headerLen[1]
  while (cursor < headerSize) {
    const t = varint(payload, cursor)
    if (!t) return null
    types.push(Number(t[0]))
    cursor += t[1]
  }
  if (types.length !== COLUMNS.length) return null

  const row = { id: rowid }
  let at = headerSize
  let truncated = false
  for (let i = 0; i < types.length; i++) {
    const { value, size, short } = readValue(payload, at, types[i])
    if (short) {
      truncated = true
      break
    }
    if (COLUMNS[i] !== 'id') row[COLUMNS[i]] = value
    at += size
  }

  // Shape check: only real items rows survive this.
  if (row.kind !== 'text' && row.kind !== 'image') return null
  if (typeof row.hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.hash)) return null
  if (!Number.isFinite(row.created_at) || row.created_at < 1_600_000_000_000) return null
  if (truncated) row._truncated = true
  return row
}

/* -------------------------------------------------------------------- run */

const walPath = join(dataDir, 'netclip.db-wal')
const dbPath = join(dataDir, 'netclip.db')

console.log(`reading ${walPath}`)
const { pageSize, frames } = readWal(walPath)
console.log(`  page size ${pageSize}, ${frames.length} frames`)

// Latest image of each page number, used to follow overflow chains.
const latest = new Map()
for (const f of frames) latest.set(f.pgno, f.page)
const dbPages = readDbPages(dbPath, pageSize)
for (const p of dbPages) if (!latest.has(p.pgno)) latest.set(p.pgno, p.page)
const overflowLookup = (pgno) => latest.get(pgno) || null

const byId = new Map()
let scanned = 0
for (const source of [frames, dbPages]) {
  for (const { pgno, page } of source) {
    scanned++
    for (const row of parseLeafPage(page, pgno, overflowLookup)) {
      const existing = byId.get(row.id)
      // Prefer the most complete version of a row seen across all frames.
      const score = (r) => (r._truncated ? 0 : 1) * 1e6 + (r.content?.length || 0) + (r.updated_at || 0) / 1e9
      if (!existing || score(row) > score(existing)) byId.set(row.id, row)
    }
  }
}

const rows = [...byId.values()].sort((a, b) => a.id - b.id)
console.log(`  scanned ${scanned} page images`)
console.log(`  recovered ${rows.length} distinct items rows\n`)

for (const r of rows) {
  const when = new Date(r.updated_at).toISOString().replace('T', ' ').slice(0, 19)
  const body =
    r.kind === 'image'
      ? `[image ${r.filename || ''} ${r.width}x${r.height}]`
      : JSON.stringify((r.content ?? '').slice(0, 60))
  console.log(
    `  id=${String(r.id).padStart(3)} ${r.kind.padEnd(5)} ${r.pinned ? '📌' : '  '} ${when}  ` +
      `${String(r.source || '').padEnd(16)} ${body}${r._truncated ? '  (TRUNCATED)' : ''}`,
  )
}

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(rows, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}
