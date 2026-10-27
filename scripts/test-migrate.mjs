#!/usr/bin/env node
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink, copyFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const run = promisify(execFile)
const cli = resolve('cli/netclip.mjs')
const root = await realpath(await mkdtemp(join(tmpdir(), 'netclip-migrate-test-')))
const bin = join(root, 'bin')
await mkdir(bin)
after(() => rm(root, { recursive: true, force: true }))

// Exercise actual shell quoting and streamed workers without contacting hosts.
await copyFile(resolve('scripts/fixtures/migration-ssh.mjs'), join(bin, 'ssh.mjs'))
await chmod(join(bin, 'ssh.mjs'), 0o755)
await symlink('ssh.mjs', join(bin, 'ssh'))

let sequence = 0
async function fixture() {
  const path = join(root, String(++sequence))
  await mkdir(path)
  const source = join(path, "source ' $literal " + String.fromCharCode(96) + 'name 中文'), target = join(path, 'target space')
  await seed(source)
  await mkdir(target)
  return { source, target }
}
async function seed(path) {
  for (const name of ['blobs', 'thumbs', 'drive', 'tmp']) await mkdir(join(path, name), { recursive: true })
  const blob = Buffer.from('binary fixture payload\0'.repeat(10000)), hash = createHash('sha256').update(blob).digest('hex')
  for (const name of ['blobs', 'thumbs']) await mkdir(join(path, name, hash.slice(0, 2)))
  await writeFile(join(path, 'blobs', hash.slice(0, 2), hash), blob)
  await writeFile(join(path, 'thumbs', hash.slice(0, 2), hash + '.webp'), 'thumbnail bytes')
  await writeFile(join(path, 'drive', 'file-key'), blob)
  await writeFile(join(path, 'drive', 'empty-key'), '')
  await writeFile(join(path, 'tmp', 'unfinished'), 'must not migrate')
  const db = new DatabaseSync(join(path, 'netclip.db'))
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, content TEXT," +
    "hash TEXT, bytes INTEGER, has_thumb INTEGER, pinned INTEGER, created_at INTEGER, updated_at INTEGER," +
    "expires_at INTEGER, copy_count INTEGER, source TEXT);" +
    "CREATE TABLE drive_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER REFERENCES drive_entries(id)," +
    "kind TEXT, name TEXT, blob_key TEXT, bytes INTEGER, created_at INTEGER, updated_at INTEGER);" +
    "CREATE TABLE extra_metadata (value TEXT);" +
    "INSERT INTO extra_metadata VALUES ('preserve future metadata too');" +
    "INSERT INTO items VALUES (41, 'text', 'full text 中文', '', 18, 0, 0, 1000, 2000, 3000, 17, 'old device');" +
    "INSERT INTO drive_entries VALUES (21, NULL, 'folder', '项目', NULL, 0, 1000, 2000);" +
    "INSERT INTO drive_entries VALUES (22, 21, 'folder', 'Empty folder', NULL, 0, 1000, 2000);" +
    "INSERT INTO drive_entries VALUES (23, 21, 'file', 'zero bytes', 'empty-key', 0, 1000, 2000);")
  db.prepare('INSERT INTO items VALUES (42, ?, NULL, ?, ?, 1, 1, 1000, 2000, NULL, 8, ?)').run('image', hash, blob.length, 'phone')
  db.prepare('INSERT INTO drive_entries VALUES (24, 21, ?, ?, ?, ?, 1000, 2000)').run('file', 'a.txt', 'file-key', blob.length)
  db.close()
}
async function migrate(fixture, extra = [], fault) {
  const args = [cli, 'migrate', '--from', 'source-alias', '--to', 'user@target-alias', '--source-dir', fixture.source,
    '--target-dir', fixture.target, '--stopped', '--json', ...extra]
  try {
    const result = await run(process.execPath, args, { timeout: 30000, env: { ...process.env, PATH: bin + ':' + process.env.PATH,
      MIGRATION_TEST_FAULT: fault || '', MIGRATION_TEST_TARGET: fixture.target } })
    return { ok: true, ...JSON.parse(result.stdout) }
  } catch (error) {
    assert.ok(error.stderr, error.message)
    return { ok: false, ...JSON.parse(error.stderr) }
  }
}
async function snapshot(path) {
  const db = new DatabaseSync(join(path, 'netclip.db'), { readOnly: true })
  try {
    return Object.fromEntries(['items', 'drive_entries', 'extra_metadata', 'sqlite_sequence'].map(table =>
      [table, db.prepare('SELECT * FROM ' + table).all().map(row => ({ ...row }))]))
  } finally { db.close() }
}
async function cleanLocks(...paths) {
  for (const path of paths) assert.equal((await readdir(path)).some(name => name.startsWith('.netclip-migrat')), false)
}

test('remote → remote preserves full history, folder IDs, bytes and metadata', async () => {
  const f = await fixture(), before = await snapshot(f.source)
  const result = await migrate(f)
  assert.equal(result.ok, true, result.error)
  assert.equal(result.history, 2); assert.equal(result.drive, 4)
  assert.deepEqual(await snapshot(f.target), before)
  assert.deepEqual(await snapshot(f.source), before)
  assert.deepEqual(await readFile(join(f.target, 'drive', 'file-key')), await readFile(join(f.source, 'drive', 'file-key')))
  assert.equal((await readFile(join(f.target, 'drive', 'empty-key'))).length, 0)
  await assert.rejects(readFile(join(f.target, 'tmp', 'unfinished')), { code: 'ENOENT' })
  await cleanLocks(f.source, f.target)
})

test('nonempty target is refused; --replace keeps an exact backup', async () => {
  const f = await fixture()
  await seed(f.target)
  const db = new DatabaseSync(join(f.target, 'netclip.db'))
  db.exec("UPDATE items SET content = 'target history' WHERE id = 41"); db.close()
  const before = await snapshot(f.target)
  const denied = await migrate(f)
  assert.equal(denied.ok, false); assert.match(denied.error, /--replace/)
  assert.deepEqual(await snapshot(f.target), before)
  const result = await migrate(f, ['--replace'])
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(await snapshot(result.backup), before)
  assert.deepEqual(await snapshot(f.target), await snapshot(f.source))
  await cleanLocks(f.source, f.target)
})

for (const fault of ['truncate', 'corrupt', 'commit']) {
  test(fault + ' failure restores target data and cleans staging', async () => {
    const f = await fixture(); await seed(f.target)
    const before = await snapshot(f.target), bytes = await readFile(join(f.target, 'drive', 'file-key'))
    const result = await migrate(f, ['--replace'], fault)
    assert.equal(result.ok, false)
    assert.match(result.error, fault === 'corrupt' ? /Checksum mismatch/ : fault === 'commit' ? /injected commit failure/ : /Incomplete migration stream/)
    assert.deepEqual(await snapshot(f.target), before)
    assert.deepEqual(await readFile(join(f.target, 'drive', 'file-key')), bytes)
    await cleanLocks(f.source, f.target)
  })
}

test('data received by target during transfer is not silently replaced', async () => {
  const f = await fixture(); await mkdir(join(f.target, 'drive'))
  const result = await migrate(f, [], 'late-write')
  assert.equal(result.ok, false); assert.match(result.error, /--replace/)
  assert.equal(await readFile(join(f.target, 'drive', 'late'), 'utf8'), 'new target upload')
  await cleanLocks(f.source, f.target)
})

test('missing referenced attachments fail validation before committing', async () => {
  const f = await fixture(); await rm(join(f.source, 'drive', 'file-key'))
  const result = await migrate(f)
  assert.equal(result.ok, false); assert.match(result.error, /Missing or invalid file/)
  assert.deepEqual(await readdir(f.target), [])
  await cleanLocks(f.source, f.target)
})

test('symlinks are refused and aliases cannot migrate a directory onto itself', async () => {
  const f = await fixture()
  const same = await migrate({ ...f, target: f.source })
  assert.equal(same.ok, false); assert.match(same.error, /locked/)
  await symlink(join(f.source, 'netclip.db'), join(f.source, 'drive', 'link'))
  const linked = await migrate(f)
  assert.equal(linked.ok, false); assert.match(linked.error, /Symlinks/)
  await cleanLocks(f.source, f.target)
})

test('uncheckpointed committed WAL rows survive migration', async () => {
  const f = await fixture()
  await run(process.execPath, ['-e', "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);" +
    "db.exec(\"PRAGMA journal_mode=WAL; UPDATE items SET content='only in WAL' WHERE id=41\");process.exit(0)", join(f.source, 'netclip.db')])
  assert.ok((await readFile(join(f.source, 'netclip.db-wal'))).length)
  const result = await migrate(f)
  assert.equal(result.ok, true, result.error)
  assert.equal((await snapshot(f.target)).items[0].content, 'only in WAL')
})

test('local mode ignores URL config and requires stopped confirmation', async () => {
  const f = await fixture()
  const args = [cli, 'migrate', '--to', 'local', '--source-dir', f.source, '--target-dir', f.target, '--json']
  await assert.rejects(run(process.execPath, args), error => /--stopped/.test(error.stderr))
  const { stdout } = await run(process.execPath, [...args, '--stopped', '--config', '/nonexistent/config'],
    { env: { ...process.env, NETCLIP_URL: 'invalid URL' } })
  assert.equal(JSON.parse(stdout).migrated, true)
})

test('SIGINT during transfer preserves both instances and removes staging', async () => {
  const f = await fixture(); await seed(f.target)
  const before = await snapshot(f.target), marker = join(root, 'interrupt-ready')
  const child = spawn(process.execPath, [cli, 'migrate', '--from', 'source-alias', '--to', 'target-alias',
    '--source-dir', f.source, '--target-dir', f.target, '--stopped', '--replace', '--json'],
  { env: { ...process.env, PATH: bin + ':' + process.env.PATH, MIGRATION_TEST_FAULT: 'interrupt', MIGRATION_TEST_MARKER: marker } })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const done = new Promise(resolve => child.on('close', resolve))
  try {
    for (let i = 0; ; i++) {
      if (await readFile(marker).catch(() => null)) break
      assert.ok(i < 200, 'export did not begin')
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    child.kill('SIGINT')
    assert.equal(await done, 1)
    assert.match(JSON.parse(stderr).error, /interrupted/)
    assert.deepEqual(await snapshot(f.target), before)
    await cleanLocks(f.source, f.target)
  } finally { child.kill('SIGKILL') }
})
