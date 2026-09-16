#!/usr/bin/env node
/**
 * Inserts recovered rows back into a live netclip database.
 *
 * Insert-only and idempotent: anything whose id or content-hash is already present is
 * skipped, so it can never clobber something that arrived after the loss. Original ids,
 * timestamps, sources and pin state are preserved so the history reads the way it did.
 *
 *   node scripts/restore-rows.mjs <dbPath> <rowsJson> [--apply]
 *
 * Without --apply it only reports what it would do.
 */
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [dbPath, rowsPath] = process.argv.slice(2)
const apply = process.argv.includes('--apply')
if (!dbPath || !rowsPath) {
  console.error('usage: node scripts/restore-rows.mjs <dbPath> <rowsJson> [--apply]')
  process.exit(1)
}

const dataDir = dirname(dbPath)
const blobPath = (hash) => join(dataDir, 'blobs', hash.slice(0, 2), hash)
const thumbPath = (hash) => join(dataDir, 'thumbs', hash.slice(0, 2), hash + '.webp')

const rows = JSON.parse(readFileSync(rowsPath, 'utf8'))
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 10000')

const existingIds = new Set(db.prepare('SELECT id FROM items').all().map((r) => r.id))
const existingHashes = new Set(db.prepare('SELECT hash FROM items').all().map((r) => r.hash))

const insert = db.prepare(`
  INSERT INTO items (id, kind, content, search_text, preview, hash, bytes, mime, filename,
                     width, height, color, has_thumb, flavor, lines, source, pinned,
                     copy_count, created_at, updated_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

const DAY = 86_400_000
const now = Date.now()
const plan = { insert: [], skipId: [], skipHash: [], noBlob: [] }

for (const row of rows) {
  if (existingIds.has(row.id)) {
    plan.skipId.push(row)
    continue
  }
  if (existingHashes.has(row.hash)) {
    plan.skipHash.push(row)
    continue
  }
  if (row.kind === 'image' && !existsSync(blobPath(row.hash))) {
    // The picture itself is gone; a row pointing at nothing would just render broken.
    plan.noBlob.push(row)
    continue
  }
  plan.insert.push(row)
}

console.log(`rows offered:            ${rows.length}`)
console.log(`  already present (id):  ${plan.skipId.length}`)
console.log(`  already present (hash):${plan.skipHash.length}`)
console.log(`  image bytes gone:      ${plan.noBlob.length}`)
console.log(`  to insert:             ${plan.insert.length}`)

if (!apply) {
  console.log('\n(dry run — pass --apply to write)')
  process.exit(0)
}

let inserted = 0
db.exec('BEGIN')
try {
  for (const row of plan.insert) {
    // A restored row must not expire the instant it lands. Keep the original lease when it
    // is still in the future, otherwise grant a fresh full one.
    const ttl = row.kind === 'image' ? 3 * DAY : 7 * DAY
    const expires = row.pinned ? null : row.expires_at > now + 60_000 ? row.expires_at : now + ttl

    const hasThumb = row.kind === 'image' && existsSync(thumbPath(row.hash)) ? 1 : 0

    insert.run(
      row.id,
      row.kind,
      row.content ?? null,
      row.search_text ?? '',
      row.preview ?? '',
      row.hash,
      row.bytes ?? 0,
      row.mime ?? null,
      row.filename ?? null,
      row.width ?? null,
      row.height ?? null,
      row.color ?? null,
      hasThumb,
      row.flavor ?? null,
      row.lines ?? 1,
      row.source ?? '',
      row.pinned ? 1 : 0,
      row.copy_count ?? 0,
      row.created_at,
      row.updated_at,
      expires,
    )
    inserted++
  }
  db.exec('COMMIT')
} catch (err) {
  db.exec('ROLLBACK')
  console.error('rolled back:', err.message)
  process.exit(1)
}

// Keep AUTOINCREMENT ahead of every id we just reinstated.
const max = db.prepare('SELECT MAX(id) AS n FROM items').get().n ?? 0
db.exec(`UPDATE sqlite_sequence SET seq = ${max} WHERE name = 'items' AND seq < ${max}`)

console.log(`\ninserted ${inserted} rows`)
console.log(`items now: ${db.prepare('SELECT COUNT(*) AS n FROM items').get().n}`)
db.close()
