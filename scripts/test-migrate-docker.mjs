#!/usr/bin/env node
// Optional integration test. Build netclip:migration-test first.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

const run = promisify(execFile), prefix = 'netclip-migration-test-' + randomUUID()
const source = prefix + '-source', target = prefix + '-target'
const volumes = [source + '-data', target + '-data']
const docker = async (...args) => (await run('docker', args, { timeout: 120000 })).stdout.trim()
const cli = (...args) => run(process.execPath, [resolve('cli/netclip.mjs'), 'migrate', '--to', 'local',
  '--source-container', source, '--target-container', target, '--json', ...args], { timeout: 120000 })
const api = async (container, path, init = {}) => JSON.parse(await docker('exec', container, 'node', '--input-type=module', '-e',
  'const response=await fetch("http://127.0.0.1:3210"+' + JSON.stringify(path) + ',' + JSON.stringify(init) +
  ');if(!response.ok)throw new Error(await response.text());console.log(await response.text())'))
const state = async container => JSON.parse(await docker('inspect', '--format', '{{json .State.Running}}', container))
async function ready(container) {
  for (let attempt = 0; ; attempt++) {
    try { await api(container, '/api/health'); return }
    catch (error) { if (attempt === 30) throw error; await new Promise(resolve => setTimeout(resolve, 250)) }
  }
}
const backupRows = (backup, table) => docker('exec', target, 'node', '-e',
  'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(' + JSON.stringify(backup + '/netclip.db') +
  ',{readOnly:true});console.log(JSON.stringify(db.prepare(' + JSON.stringify('SELECT * FROM ' + table) + ').all()))')

try {
  for (let i = 0; i < 2; i++) {
    await docker('run', '-d', '--name', [source, target][i], '-v', volumes[i] + ':/data', 'netclip:migration-test')
    await ready([source, target][i])
  }
  const text = (await api(source, '/api/items', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Docker migration: pinned text 中文' }) })).item
  await api(source, '/api/items/' + text.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"pinned":true}' })
  const folder = (await api(source, '/api/drive/folders', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"name":"Test folder"}' })).entry
  const file = (await api(source, '/api/drive/upload?parent=' + folder.id, { method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-filename': 'test.txt' }, body: 'Docker migration payload' })).entry
  const original = await api(source, '/api/items/' + text.id)
  const result = JSON.parse((await cli()).stdout)
  assert.equal(result.history, 1); assert.equal(result.drive, 2)
  assert.equal(await state(source), true); assert.equal(await state(target), true)
  assert.deepEqual(await api(target, '/api/items/' + text.id), original)
  assert.equal((await api(target, '/api/drive/entries/' + file.id)).entry.parentId, folder.id)
  const payload = await docker('exec', target, 'node', '--input-type=module', '-e',
    'console.log(await (await fetch("http://127.0.0.1:3210/api/drive/entries/' + file.id + '/download")).text())')
  assert.equal(payload, 'Docker migration payload')
  console.log('PASS: running Docker instances migrate, restart, and serve original IDs and bytes')

  const targetOnly = (await api(target, '/api/items', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"text":"target history to back up"}' })).item
  await assert.rejects(cli(), error => /--replace/.test(error.stderr))
  assert.equal(await state(source), true); assert.equal(await state(target), true)
  const replaced = JSON.parse((await cli('--replace')).stdout)
  assert.ok(JSON.parse(await backupRows(replaced.backup, 'items')).some(row => row.id === targetOnly.id))
  console.log('PASS: nonempty Docker target requires --replace and retains its original database')

  await docker('stop', source, target)
  const stopped = JSON.parse((await cli('--replace')).stdout)
  assert.equal(stopped.migrated, true)
  assert.equal(await state(source), false); assert.equal(await state(target), false)
  console.log('PASS: originally stopped containers remain stopped')

  await docker('start', source)
  await ready(source)
  await api(source, '/api/items', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"text":"trigger startup failure"}' })
  await docker('rm', target)
  const guard = 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/data/netclip.db");' +
    'if(db.prepare("SELECT id FROM items WHERE content=?").get("trigger startup failure"))process.exit(1);db.close()'
  await docker('run', '-d', '--name', target, '-v', volumes[1] + ':/data', 'netclip:migration-test',
    'sh', '-c', "node -e '" + guard + "' && exec node src/index.js")
  await ready(target)
  const beforeFailure = await api(target, '/api/items')
  await assert.rejects(cli('--replace'), error => /not running|exited/.test(error.stderr))
  assert.equal(await state(source), true); assert.equal(await state(target), true)
  assert.deepEqual(await api(target, '/api/items'), beforeFailure)
  console.log('PASS: target startup failure rolls back the database and restores the previous service')
} finally {
  await docker('rm', '-f', source, target).catch(() => {})
  await docker('volume', 'rm', ...volumes).catch(() => {})
}
