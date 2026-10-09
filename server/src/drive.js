import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { config, paths } from './config.js'
import { db } from './db.js'
import { broadcast } from './events.js'
import { HttpError, json, readBody, sendFile } from './http.js'
import { sendZip } from './zip.js'

// Permanent drive files have their own table and directory, outside clipboard cleanup.
await mkdir(paths.drive, { recursive: true })
db.exec(`
  CREATE TABLE IF NOT EXISTS drive_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES drive_entries(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
    name TEXT NOT NULL,
    blob_key TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS drive_names ON drive_entries(COALESCE(parent_id, 0), name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS drive_parent ON drive_entries(parent_id);
`)

const get = (id) => db.prepare('SELECT * FROM drive_entries WHERE id = ?').get(id)
const dto = (r) => ({ id: r.id, parentId: r.parent_id, kind: r.kind, name: r.name,
  bytes: r.bytes, createdAt: r.created_at, updatedAt: r.updated_at })
const idOf = (value) => {
  if (value === undefined || value === null || value === '' || value === 'root') return null
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, 'Invalid folder ID')
  return id
}
const nameOf = (value) => {
  const name = String(value ?? '').trim().normalize('NFC')
  if (!name || name === '.' || name === '..' || /[/\\\u0000-\u001f\u007f]/.test(name) || Buffer.byteLength(name) > 240) {
    throw new HttpError(400, 'Use a name of 1–240 bytes, without slashes or control characters.')
  }
  return name
}
function folder(id) {
  if (id === null) return null
  const row = get(id)
  if (!row || row.kind !== 'folder') throw new HttpError(404, 'Folder not found')
  return row
}
function ancestors(id) {
  const rows = []
  while (id !== null) {
    const row = folder(id)
    rows.unshift(dto(row))
    id = row.parent_id
  }
  return rows
}
const conflict = (parent, name, except = -1) => db.prepare(
  'SELECT id FROM drive_entries WHERE parent_id IS ? AND name = ? COLLATE NOCASE AND id != ?',
).get(parent, name, except)
function availableName(parent, name, isFolder = false) {
  const ext = isFolder ? '' : extname(name), stem = name.slice(0, name.length - ext.length)
  let next = name
  for (let i = 2; conflict(parent, next); i++) next = `${stem} (${i})${ext}`
  return next
}
function changed() { broadcast('drive', { changed: true }) }
async function bodyOf(req) {
  try {
    const body = JSON.parse((await readBody(req, 8192)).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid JSON')
    return body
  }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'Invalid JSON') }
}

async function upload(req, res, url) {
  const parent = idOf(url.searchParams.get('parent'))
  folder(parent)
  let filename
  try { filename = decodeURIComponent(String(req.headers['x-filename'] || 'file')) }
  catch { throw new HttpError(400, 'Invalid filename') }
  const name = nameOf(filename)
  if (Number(req.headers['content-length']) > config.driveMaxUploadBytes) throw new HttpError(413, 'File exceeds the drive upload limit')
  const key = randomUUID()
  const temporary = join(paths.drive, `${key}.part`), target = join(paths.drive, key)
  const handle = await open(temporary, 'wx', 0o600)
  let bytes = 0, closed = false, entry
  try {
    // Stream to disk: a large upload never needs to fit into a single memory buffer.
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > config.driveMaxUploadBytes) throw new HttpError(413, 'File exceeds the drive upload limit')
      await handle.writeFile(chunk)
    }
    await handle.sync()
    await handle.close(); closed = true
    await rename(temporary, target)
    folder(parent) // The destination might have been deleted while the file was uploading.
    const now = Date.now()
    const result = db.prepare(`INSERT INTO drive_entries
      (parent_id,kind,name,blob_key,bytes,created_at,updated_at) VALUES (?,'file',?,?,?,?,?)`
    ).run(parent, availableName(parent, name), key, bytes, now, now)
    entry = dto(get(Number(result.lastInsertRowid)))
  } catch (error) {
    if (!closed) await handle.close().catch(() => {})
    await Promise.all([rm(temporary, { force: true }), rm(target, { force: true })])
    if (error.code === 'ENOSPC') throw new HttpError(507, 'The drive is out of space')
    throw error
  }
  changed()
  json(res, 201, { entry })
}

function archiveEntries(ids) {
  const selected = new Set(ids)
  const roots = ids.map((id) => {
    const row = get(id)
    if (!row) throw new HttpError(404, 'File or folder not found')
    return row
  }).filter((row) => !ancestors(row.parent_id).some((parent) => selected.has(parent.id)))
  const children = db.prepare('SELECT * FROM drive_entries WHERE parent_id = ? ORDER BY name COLLATE NOCASE')
  const names = new Set(), entries = []
  for (const root of roots) {
    let name = root.name
    const ext = root.kind === 'file' ? extname(name) : '', stem = name.slice(0, name.length - ext.length)
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`
    names.add(name.toLowerCase())
    const pending = [{ row: root, path: name }]
    while (pending.length) {
      const { row, path } = pending.pop()
      entries.push({ path, bytes: row.bytes, updatedAt: row.updated_at,
        source: row.kind === 'file' ? join(paths.drive, row.blob_key) : null })
      if (row.kind === 'folder') {
        for (const child of children.all(row.id).reverse()) pending.push({ row: child, path: `${path}/${child.name}` })
      }
    }
  }
  return entries
}

export async function handleDrive(req, res, url) {
  const method = req.method === 'HEAD' ? 'GET' : req.method
  if (url.pathname === '/api/drive/download' && method === 'GET') {
    const ids = [...new Set((url.searchParams.get('ids') || '').split(',').map(idOf))]
    if (!ids.length || ids.includes(null)) throw new HttpError(400, 'Select files or folders to download')
    const entries = archiveEntries(ids)
    const filename = ids.length === 1 ? `${get(ids[0]).name}.zip` : 'netclip-download.zip'
    return sendZip(req, res, entries, filename)
  }
  if (url.pathname === '/api/drive/entries' && method === 'GET') {
    const parent = idOf(url.searchParams.get('parent'))
    folder(parent)
    const q = (url.searchParams.get('q') || '').normalize('NFC').toLocaleLowerCase()
    const rows = db.prepare('SELECT * FROM drive_entries WHERE parent_id IS ? ORDER BY kind DESC, name COLLATE NOCASE').all(parent)
    const stats = db.prepare(`SELECT COALESCE(SUM(bytes),0) AS bytes,
      SUM(kind='file') AS files, SUM(kind='folder') AS folders FROM drive_entries`).get()
    return json(res, 200, { entries: rows.filter((r) => !q || r.name.toLocaleLowerCase().includes(q)).map(dto),
      breadcrumbs: ancestors(parent), stats, maxUploadBytes: config.driveMaxUploadBytes })
  }
  if (url.pathname === '/api/drive/folders' && method === 'POST') {
    const body = await bodyOf(req), parent = idOf(body.parentId)
    let name = nameOf(body.name)
    folder(parent)
    if (body.autoRename === true) name = availableName(parent, name, true)
    if (conflict(parent, name)) throw new HttpError(409, 'A file or folder with this name already exists')
    const now = Date.now()
    const result = db.prepare("INSERT INTO drive_entries(parent_id,kind,name,created_at,updated_at) VALUES (?,'folder',?,?,?)").run(parent, name, now, now)
    changed()
    return json(res, 201, { entry: dto(get(Number(result.lastInsertRowid))) })
  }
  if (url.pathname === '/api/drive/upload' && method === 'POST') return upload(req, res, url)

  const match = /^\/api\/drive\/entries\/(\d+)(\/download)?$/.exec(url.pathname)
  if (!match) throw new HttpError(404, 'No such drive endpoint')
  const id = idOf(match[1]), row = get(id)
  if (!row) throw new HttpError(404, 'File or folder not found')
  if (match[2] && method === 'GET' && row.kind === 'file') {
    const sent = await sendFile(req, res, join(paths.drive, row.blob_key), {
      contentType: 'application/octet-stream', filename: row.name, inline: false,
      cacheControl: 'no-store', headers: { 'X-Content-Type-Options': 'nosniff' },
    })
    if (!sent) throw new HttpError(404, 'File content not found')
    return
  }
  if (match[2] && method === 'GET') return sendZip(req, res, archiveEntries([id]), `${row.name}.zip`)
  if (match[2]) throw new HttpError(405, 'Method not allowed')
  if (method === 'GET') return json(res, 200, { entry: dto(row), breadcrumbs: ancestors(row.parent_id) })
  if (method === 'PATCH') {
    const body = await bodyOf(req)
    const name = body.name === undefined ? row.name : nameOf(body.name)
    const parent = body.parentId === undefined ? row.parent_id : idOf(body.parentId)
    folder(parent)
    if (row.kind === 'folder' && (parent === id || ancestors(parent).some((p) => p.id === id))) {
      throw new HttpError(400, 'A folder cannot be moved inside itself')
    }
    if (conflict(parent, name, id)) throw new HttpError(409, 'A file or folder with this name already exists')
    db.prepare('UPDATE drive_entries SET name=?, parent_id=?, updated_at=? WHERE id=?').run(name, parent, Date.now(), id)
    changed()
    return json(res, 200, { entry: dto(get(id)) })
  }
  if (method === 'DELETE') {
    const descendants = db.prepare(`WITH RECURSIVE subtree AS (
      SELECT id,blob_key FROM drive_entries WHERE id=? UNION ALL
      SELECT e.id,e.blob_key FROM drive_entries e JOIN subtree s ON e.parent_id=s.id
    ) SELECT * FROM subtree`).all(id)
    db.prepare('DELETE FROM drive_entries WHERE id=?').run(id)
    await Promise.all(descendants.filter((r) => r.blob_key).map((r) => rm(join(paths.drive, r.blob_key), { force: true })))
    changed()
    return json(res, 200, { deleted: descendants.length })
  }
  throw new HttpError(405, 'Method not allowed')
}
