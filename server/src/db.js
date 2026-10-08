import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { config, paths } from './config.js'

for (const dir of [config.dataDir, paths.blobs, paths.thumbs, paths.tmp]) {
  mkdirSync(dir, { recursive: true })
}

export const db = new DatabaseSync(paths.db)

const ITEM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT    NOT NULL CHECK (kind IN ('text', 'image', 'file')),
    -- text rows: the full payload. image rows: NULL.
    content     TEXT,
    -- NFKC-folded, lowercased haystack for LIKE search: content + filename.
    search_text TEXT    NOT NULL DEFAULT '',
    -- what a list row shows without paying for the full payload
    preview     TEXT    NOT NULL DEFAULT '',
    -- sha256 of the payload; identical payloads bump instead of duplicating
    hash        TEXT    NOT NULL,
    bytes       INTEGER NOT NULL DEFAULT 0,
    -- image rows only
    mime        TEXT,
    filename    TEXT,
    width       INTEGER,
    height      INTEGER,
    color       TEXT,
    has_thumb   INTEGER NOT NULL DEFAULT 0,
    -- text rows only: 'url' | 'color' | 'json' | 'text' — drives the row icon and actions
    flavor      TEXT,
    lines       INTEGER NOT NULL DEFAULT 1,

    source      TEXT    NOT NULL DEFAULT '',
    pinned      INTEGER NOT NULL DEFAULT 0,
    copy_count  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    -- NULL means "no lease, never expires" (i.e. pinned)
    expires_at  INTEGER
  );
`

db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
const oldSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'").get()
if (oldSchema && !oldSchema.sql.includes("'file'")) {
  // SQLite cannot alter a CHECK constraint. Preserve every row and the ID high-water mark.
  db.exec('BEGIN IMMEDIATE')
  try {
    const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'items'").get()?.seq ?? 0
    db.exec('ALTER TABLE items RENAME TO items_legacy')
    db.exec(ITEM_SCHEMA)
    db.exec('INSERT INTO items SELECT * FROM items_legacy; DROP TABLE items_legacy;')
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'items'").run()
    db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('items', ?)").run(sequence)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
} else {
  db.exec(ITEM_SCHEMA)
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_items_hash   ON items (hash);
  CREATE INDEX IF NOT EXISTS        idx_items_order  ON items (pinned DESC, updated_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS        idx_items_expiry ON items (expires_at) WHERE expires_at IS NOT NULL;
`)

/**
 * The sweeper only runs every few minutes, so every read also filters on the lease.
 * An expired item is never visible, whatever the sweeper's timing.
 */
const LIVE = `(pinned = 1 OR expires_at IS NULL OR expires_at > :now)`

// A list response carries full content only for small text rows (see config.inlineTextBytes);
// anything larger would make the payload unbounded, and is fetched per-item instead.
const LIST_COLS = `
  id, kind, preview, hash, bytes, mime, filename, width, height, color, has_thumb,
  flavor, lines, source, pinned, copy_count, created_at, updated_at, expires_at,
  CASE WHEN kind = 'text' AND bytes <= ${config.inlineTextBytes} THEN content END AS content
`

const q = {
  byId: db.prepare(`SELECT * FROM items WHERE id = ?`),
  byHash: db.prepare(`SELECT * FROM items WHERE hash = ?`),

  list: db.prepare(`
    SELECT ${LIST_COLS} FROM items
    WHERE ${LIVE}
    ORDER BY pinned DESC, updated_at DESC, id DESC
    LIMIT :limit OFFSET :offset
  `),
  search: db.prepare(`
    SELECT ${LIST_COLS} FROM items
    WHERE ${LIVE} AND search_text LIKE :needle ESCAPE '\\'
    ORDER BY pinned DESC, updated_at DESC, id DESC
    LIMIT :limit OFFSET :offset
  `),

  insert: db.prepare(`
    INSERT INTO items (kind, content, search_text, preview, hash, bytes, mime, filename,
                       width, height, color, has_thumb, flavor, lines, source, pinned,
                       created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `),
  bump: db.prepare(`UPDATE items SET updated_at = ?, expires_at = ?, source = ? WHERE id = ?`),
  // A copy renews the lease and counts the use, but deliberately leaves updated_at alone:
  // copying on your phone should not reshuffle the list you are looking at on your laptop.
  touchCopy: db.prepare(`
    UPDATE items SET copy_count = copy_count + 1,
                     expires_at = CASE WHEN pinned = 1 THEN NULL ELSE ? END
    WHERE id = ?
  `),
  setPinned: db.prepare(`UPDATE items SET pinned = ?, updated_at = ?, expires_at = ? WHERE id = ?`),
  del: db.prepare(`DELETE FROM items WHERE id = ?`),

  expired: db.prepare(`
    SELECT id, kind, hash FROM items
    WHERE pinned = 0 AND expires_at IS NOT NULL AND expires_at <= ?
  `),
  evictable: db.prepare(`
    SELECT id, kind, hash, bytes FROM items
    WHERE pinned = 0 AND updated_at <= ?
    ORDER BY updated_at ASC, id ASC
  `),
  evictableBlobs: db.prepare(`
    SELECT id, kind, hash, bytes FROM items
    WHERE pinned = 0 AND kind IN ('image', 'file') AND updated_at <= ?
    ORDER BY updated_at ASC, id ASC
  `),
  countUnpinned: db.prepare(`SELECT COUNT(*) AS n FROM items WHERE pinned = 0`),
  totalBytes: db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS n FROM items`),
  stats: db.prepare(`
    SELECT COUNT(*) AS total,
           COALESCE(SUM(pinned), 0) AS pinned,
           COALESCE(SUM(bytes), 0) AS bytes
    FROM items
  `),
  allUnpinned: db.prepare(`SELECT id, kind, hash FROM items WHERE pinned = 0`),
  allHashes: db.prepare(`SELECT hash FROM items`),
}

/** SQLite LIKE metacharacters, escaped to match the ESCAPE clause above. */
const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&')

/**
 * One folding function, used both when writing a row and when reading a query, so the two
 * can never drift. NFKC collapses full-width forms (ＡＢＣ → ABC), which is what makes a
 * search typed on a Chinese IME match text pasted from anywhere else.
 */
export const fold = (s) => (s || '').normalize('NFKC').toLowerCase()

export function listItems({ query = '', limit = 300, offset = 0, now = Date.now() } = {}) {
  const trimmed = query.trim()
  if (!trimmed) return q.list.all({ now, limit, offset })
  return q.search.all({ now, needle: `%${escapeLike(fold(trimmed))}%`, limit, offset })
}

export const getItem = (id) => q.byId.get(id)
export const getItemByHash = (hash) => q.byHash.get(hash)
export const deleteItem = (id) => q.del.run(id).changes > 0
export const getStats = () => q.stats.get()
export const listExpired = (now) => q.expired.all(now)
export const listEvictable = (before) => q.evictable.all(before)
export const listEvictableBlobs = (before) => q.evictableBlobs.all(before)
export const listAllUnpinned = () => q.allUnpinned.all()
export const allHashes = () => new Set(q.allHashes.all().map((r) => r.hash))
export const countUnpinned = () => q.countUnpinned.get().n
export const totalBytes = () => q.totalBytes.get().n

export function insertItem(row) {
  const info = q.insert.run(
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
    row.has_thumb ? 1 : 0,
    row.flavor ?? null,
    row.lines ?? 1,
    row.source ?? '',
    row.created_at,
    row.updated_at,
    row.expires_at ?? null,
  )
  return q.byId.get(Number(info.lastInsertRowid))
}

/** Re-copying something that is already in history moves it back to the top, Raycast-style. */
export function bumpItem(id, { now, expiresAt, source }) {
  const existing = q.byId.get(id)
  if (!existing) return null
  q.bump.run(now, existing.pinned ? null : expiresAt, source || existing.source, id)
  return q.byId.get(id)
}

export function countCopy(id, expiresAt) {
  if (!q.byId.get(id)) return null
  q.touchCopy.run(expiresAt, id)
  return q.byId.get(id)
}

/**
 * Unpinning grants a fresh, full lease rather than resurrecting an old one — otherwise
 * unpinning a six-month-old pin would delete it milliseconds later, which reads as
 * "the app ate my data".
 */
export function setPinned(id, pinned, { now, expiresAt }) {
  const existing = q.byId.get(id)
  if (!existing) return null
  // Keep the row where it is in the list; pinning is not a "use".
  q.setPinned.run(pinned ? 1 : 0, existing.updated_at, pinned ? null : expiresAt, id)
  return q.byId.get(id)
}

export function close() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;')
    db.close()
  } catch {
    /* already closing */
  }
}
