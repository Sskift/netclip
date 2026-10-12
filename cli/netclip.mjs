#!/usr/bin/env node
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, writeFile, appendFile, mkdir, rename, rm, lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import { randomUUID, createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const HELP = `Netclip — shared clipboard and Drive CLI (Node 22+; no dependencies)

  netclip config [URL]                       Show config or save the server URL
  netclip drive ls [PATH]                    List a folder (default /)
  netclip drive tree [PATH]                  List a folder recursively
  netclip drive mkdir PATH                   Create folders, including parents
  netclip drive upload LOCAL... --to PATH    Upload files or whole folder trees
  netclip drive download PATH... [--to DIR]  Download files/folders, retaining structure
  netclip drive mount [--to DIR]            Mount macOS Drive with on-demand downloads
  netclip drive unmount [--to DIR]          Eject the macOS volume
  netclip drive status [--to DIR]           Show mount and cache policy
  netclip drive refresh [--to DIR]          Refresh the mounted directory index
  netclip drive bind PATH LOCAL_DIR          Remember this folder's download directory
  netclip drive unbind PATH                  Remove a folder's download binding
  netclip drive bindings                     List bindings for the active server
  netclip drive rename PATH NAME             Rename an entry
  netclip drive move PATH... --to FOLDER     Move entries
  netclip drive rm PATH...                   Delete entries (folders recursively)
  netclip clipboard list [--query TEXT]      List clipboard items
  netclip clipboard get ID                   Print an item's full text or metadata
  netclip clipboard put [TEXT]               Send text; omitted TEXT reads stdin
  netclip clipboard upload LOCAL...         Send images or attachments
  netclip clipboard download ID [--to DIR]   Download an item's original bytes
  netclip clipboard pin|unpin|rm ID...       Manage clipboard history

Options: --json, --url URL, --config FILE, --to DIR, --query TEXT, --help
Environment: NETCLIP_URL, NETCLIP_CONFIG, NETCLIP_RCLONE (macOS mount helper)
Remote paths start at /; use id:123 to address an entry by ID.
Downloads use --to, the nearest bound folder, or ~/Downloads/Netclip.
Bindings are local to this machine and server, survive remote renames, and apply
inside subfolders. Existing local files get a numbered suffix; nothing is overwritten.
Examples:
  netclip config http://100.106.235.95:3210
  netclip drive bind /Projects ~/Downloads/Projects
  netclip drive download /Projects
  netclip drive upload ./report.pdf ./assets --to /Projects --json
  printf 'ready' | netclip clipboard put --json
`

let options, args
try {
  ;({ values: options, positionals: args } = parseArgs({ allowPositionals: true, options: {
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    url: { type: 'string' }, config: { type: 'string' }, to: { type: 'string' }, query: { type: 'string' },
  } }))
} catch (error) {
  process.stderr.write(process.argv.includes('--json') ? JSON.stringify({ error: error.message }) + '\n' : `netclip: ${error.message}\n`)
  process.exit(1)
}
const localPath = (path) => resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)
const configPath = localPath(options.config || process.env.NETCLIP_CONFIG || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'netclip', 'config.json'))
const completed = []
let config, base
const output = (value) => {
  if (options.json || typeof value !== 'string') process.stdout.write(JSON.stringify(value, null, options.json ? 0 : 2) + '\n')
  else process.stdout.write(value + '\n')
}
const required = (value, label) => { if (!value) throw new Error(`${label} is required. Run netclip --help.`); return value }
const serverUrl = (value) => {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use a server URL such as http://100.106.235.95:3210')
  return url.origin
}
async function saveConfig() {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  const temp = `${configPath}.${randomUUID()}.tmp`
  try { await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); await rename(temp, configPath) }
  finally { await rm(temp, { force: true }) }
}
async function request(path, init = {}) {
  let response
  try { response = await fetch(base + path, init) }
  catch (error) { throw new Error(`Cannot reach ${base}: ${error.cause?.message || error.message}`) }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { status: response.status })
  }
  return response
}
async function api(path, method = 'GET', body) {
  const response = await request(path, { method, ...(body === undefined ? {} : {
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) })
  return response.status === 204 ? null : response.json()
}
const list = (id) => api('/api/drive/entries' + (id ? `?parent=${id}` : ''))
const root = { id: null, kind: 'folder', name: '', parentId: null }
const remotePath = (chain) => '/' + chain.filter(entry => entry.id !== null).map(entry => entry.name).join('/')
function partsOf(path) {
  if (path.includes('\\') || path.includes('\0')) throw new Error('Use / as the remote path separator')
  const parts = path.split('/').filter(Boolean)
  if (parts.some(part => part === '.' || part === '..')) throw new Error('Remote paths cannot contain . or ..')
  return parts
}
async function locate(path = '/', create = false) {
  if (/^id:[1-9]\d*$/.test(path)) {
    const { entry, breadcrumbs } = await api(`/api/drive/entries/${path.slice(3)}`)
    return [root, ...breadcrumbs, entry]
  }
  const chain = [root]
  for (const name of partsOf(path)) {
    if (chain.at(-1).kind !== 'folder') throw new Error(`${remotePath(chain)} is not a folder`)
    const parentId = chain.at(-1).id
    const { entries } = await list(parentId)
    let entry = entries.find(entry => entry.name === name.normalize('NFC'))
    if (!entry && create) {
      try { entry = (await api('/api/drive/folders', 'POST', { name, parentId })).entry }
      catch (error) {
        if (error.status !== 409) throw error
        entry = (await list(parentId)).entries.find(entry => entry.name === name.normalize('NFC'))
        if (!entry) throw error
      }
    }
    if (!entry) throw new Error(`Not found: ${remotePath(chain)}/${name}`.replace('//', '/'))
    if (create && entry.kind !== 'folder') throw new Error(`${name} is a file, not a folder`)
    chain.push(entry)
  }
  return chain
}
function folder(chain) {
  const entry = chain.at(-1)
  if (entry.kind !== 'folder') throw new Error(`${remotePath(chain)} is not a folder`)
  return entry
}
function filename(name) {
  // Never interpret a remote filename as a local path, including on Windows.
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new Error(`Invalid download filename: ${name}`)
  let safe = name.replace(/[<>:"|?*\u0001-\u001f]/g, '_').replace(/[. ]+$/, '_')
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe)) safe = '_' + safe
  return safe
}
async function directory(path) {
  await mkdir(path, { recursive: true })
  const info = await lstat(path)
  if (!info.isDirectory()) throw new Error(`Not a directory (or is a symbolic link): ${path}`)
}
function numbered(path, n) {
  if (n === 1) return path
  const ext = extname(path)
  return `${path.slice(0, path.length - ext.length)} (${n})${ext}`
}
async function saveFile(url, path) {
  await directory(dirname(path))
  const response = await request(url)
  let target, stream
  for (let n = 1; ; n++) {
    target = numbered(path, n)
    stream = createWriteStream(target, { flags: 'wx' })
    try { await new Promise((done, fail) => { stream.once('open', done); stream.once('error', fail) }); break }
    catch (error) { if (error.code !== 'EEXIST') { await response.body.cancel(); throw error } }
  }
  try { await pipeline(response.body, stream) }
  catch (error) { await rm(target, { force: true }); throw error }
  return target
}
const bindings = () => config.downloads?.[base] || {}
function destination(chain, explicit) {
  const item = chain.at(-1)
  if (explicit) return item.id === null ? localPath(explicit) : join(localPath(explicit), filename(item.name))
  for (let i = chain.length - 1; i >= 0; i--) {
    const bound = bindings()[String(chain[i].id ?? 'root')]
    if (bound) return join(bound.directory, ...chain.slice(i + 1).map(entry => filename(entry.name)))
  }
  return item.id === null ? join(homedir(), 'Downloads', 'Netclip') : join(homedir(), 'Downloads', 'Netclip', filename(item.name))
}
async function downloadEntry(chain, explicit, inherited) {
  const entry = chain.at(-1), path = inherited || destination(chain, explicit)
  if (entry.kind === 'folder') {
    await directory(path)
    completed.push({ kind: 'folder', remote: remotePath(chain), local: path })
    for (const child of (await list(entry.id)).entries) {
      // Keep a selected folder together, including all nested and empty folders.
      await downloadEntry([...chain, child], undefined, join(path, filename(child.name)))
    }
  } else {
    const local = await saveFile(`/api/drive/entries/${entry.id}/download`, path)
    completed.push({ kind: 'file', remote: remotePath(chain), local, bytes: entry.bytes })
  }
}
async function uploadPath(path, parentId, remote) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error(`Not a regular file or folder: ${path}`)
  const name = basename(path)
  if (info.isDirectory()) {
    const { entry } = await api('/api/drive/folders', 'POST', { name, parentId, autoRename: true })
    completed.push({ ...entry, path: `${remote}/${entry.name}` })
    for (const child of (await readdir(path)).sort()) await uploadPath(join(path, child), entry.id, `${remote}/${entry.name}`)
  } else {
    const source = createReadStream(path)
    try {
      const response = await request('/api/drive/upload' + (parentId ? `?parent=${parentId}` : ''), {
        method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': String(info.size), 'x-filename': encodeURIComponent(name) },
        body: source, duplex: 'half',
      })
      const { entry } = await response.json()
      completed.push({ ...entry, path: `${remote}/${entry.name}` })
    } finally { source.destroy() }
  }
}
async function mountDrive(command, previousDirectory) {
  if (process.platform !== 'darwin') throw new Error('This mount command requires macOS')
  const run = promisify(execFile), url = base + '/dav/'
  const entryDirectory = join(homedir(), 'Netclip')
  // Keep the Favorites entry on the local disk; a bookmark to the NFS volume
  // becomes unresolvable after ejecting or remounting that volume.
  const directory = previousDirectory || localPath(options.to || join(entryDirectory, 'Drive'))
  if (command === 'mount' && !options.to && !previousDirectory) {
    const oldKey = createHash('sha256').update(entryDirectory).digest('hex').slice(0, 16)
    let oldState
    try { oldState = JSON.parse(await readFile(join(dirname(configPath), 'mounts', oldKey + '.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (oldState?.directory === entryDirectory) await mountDrive('unmount', entryDirectory)
  }
  if (/[\r\n]/.test(directory)) throw new Error('The mount directory cannot contain line breaks')
  const key = createHash('sha256').update(directory).digest('hex').slice(0, 16)
  const stateDir = join(dirname(configPath), 'mounts'), stateFile = join(stateDir, key + '.json')
  const cacheDirectory = join(homedir(), 'Library', 'Caches', 'Netclip', 'mounts', key)
  const logFile = join(stateDir, key + '.log')
  const signal = (pid, name) => { try { process.kill(pid, name) } catch (error) { if (error.code !== 'ESRCH') throw error } }
  const mountLine = async () => (await run('/sbin/mount', [])).stdout.split('\n').find(line => line.includes(` on ${directory} (`))
  let state
  try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const helperRunning = async () => {
    if (state?.directory !== directory || !Number.isSafeInteger(state.pid) || state.pid <= 1) return false
    const ps = await run('/bin/ps', ['-p', String(state.pid), '-o', 'command=']).catch(() => ({ stdout: '' }))
    return ps.stdout.includes(` nfsmount :webdav: ${directory} --webdav-url ${state.server}/dav/ `)
  }
  let running = await helperRunning()
  const stopHelper = async () => {
    running = await helperRunning()
    if (!running) return
    signal(state.pid, 'SIGTERM')
    for (let attempt = 0; attempt < 50; attempt++) {
      const ps = await run('/bin/ps', ['-p', String(state.pid), '-o', 'command=']).catch(() => ({ stdout: '' }))
      if (!ps.stdout.includes(` nfsmount :webdav: ${directory} --webdav-url ${state.server}/dav/ `)) { running = false; return }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error(`The old mount helper is still stopping; retry in a moment`)
  }
  let mounted = await mountLine()
  const legacy = mounted?.startsWith(`${url} on `) && mounted.includes('(webdav,')
  const owned = running && state.server === base && mounted?.startsWith('localhost:/ on ') && mounted.includes('(nfs,')
  const report = () => previousDirectory ? undefined : output({ server: base, directory, mounted: Boolean(mounted), helperRunning: running, readOnly: true,
    disconnectedReason: state?.disconnectedReason || null,
    contentCache: running && mounted ? 'on-demand' : mounted && legacy ? 'macOS-managed' : null,
    cacheTargetBytes: 268435456, activeFilesMayExceedTarget: true, cacheIdleSeconds: 30, cacheSweepSeconds: 10,
    directoryCacheSeconds: 30, readBufferBytes: 0, cacheDirectory, logFile })
  if (command === '_guard') {
    if (state?.directory !== directory || state.server !== base || !Number.isSafeInteger(state.pid) || state.pid <= 1) return
    const pid = state.pid
    const sameMount = async () => {
      try { return JSON.parse(await readFile(stateFile, 'utf8')).pid === pid }
      catch (error) { if (error.code === 'ENOENT') return false; throw error }
    }
    let failures = 0
    while (await sameMount()) {
      await new Promise(resolve => setTimeout(resolve, 5_000))
      if (!await sameMount()) return
      mounted = await mountLine()
      if (mounted && (!mounted.startsWith('localhost:/ on ') || !mounted.includes('(nfs,') || !mounted.includes('read-only'))) return
      running = await helperRunning()
      if (mounted) {
        try {
          if (!running) throw new Error('Mount helper stopped')
          const response = await fetch(url, { method: 'PROPFIND', headers: { Depth: '0' }, signal: AbortSignal.timeout(3_000) })
          await response.body?.cancel()
          if (response.status !== 207) throw new Error('Drive is unavailable')
          failures = 0
        } catch { failures++ }
        if (running && failures < 2) continue
        if (!await sameMount()) return
        // macOS can repeatedly retry NFS directory errors even on a soft mount.
        // Detach only this read-only volume so an outage cannot trap Finder.
        await run('/sbin/umount', ['-f', directory], { timeout: 10_000 })
      }
      await stopHelper()
      if (!await sameMount()) return
      await rm(cacheDirectory, { recursive: true, force: true })
      const disconnectedReason = failures ? 'Drive disconnected. Check the connection, then run netclip drive mount.' : 'Volume ejected. Run netclip drive mount to reconnect.'
      await writeFile(stateFile, JSON.stringify({ server: base, directory, disconnectedReason }) + '\n', { mode: 0o600 })
      await appendFile(logFile, `${new Date().toISOString()} ${disconnectedReason}\n`)
      return
    }
    return
  }
  if (mounted && !legacy && !owned) throw new Error(`Another mount is using ${directory}`)
  if (command === 'status') return report()
  if (command === 'refresh') {
    if (!owned) throw new Error('Mount Drive first with netclip drive mount')
    signal(state.pid, 'SIGHUP')
    return output({ server: base, directory, refreshed: true })
  }
  if (command === 'unmount' || legacy) {
    if (mounted) await run('/sbin/umount', [directory], { timeout: 30_000 })
    await stopHelper()
    await rm(stateFile, { force: true })
    await rm(cacheDirectory, { recursive: true, force: true })
    mounted = undefined; running = false
    if (command === 'unmount') return report()
  }
  if (owned) return report()
  // Finder may have ejected the volume while its local NFS helper is still alive.
  await stopHelper()
  let rclone = process.env.NETCLIP_RCLONE || join(homedir(), '.local', 'bin', 'rclone')
  try { await run(rclone, ['version']) }
  catch (error) {
    if (process.env.NETCLIP_RCLONE || error.code !== 'ENOENT') throw error
    rclone = 'rclone'
    try { await run(rclone, ['version']) }
    catch { throw new Error('Install the official macOS rclone binary in ~/.local/bin/rclone first. See the README Mount Drive section.') }
  }
  const response = await fetch(url, { method: 'OPTIONS', signal: AbortSignal.timeout(10_000) })
  if (!response.ok || !response.headers.get('dav')) throw new Error('This server does not expose Netclip WebDAV. Update the server first.')
  await mkdir(directory, { recursive: true })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(directory)).length) throw new Error('Choose an empty directory for the mount')
  await rm(cacheDirectory, { recursive: true, force: true }) // Discard only this read-only mount's cache from a previous run.
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const child = spawn(rclone, ['nfsmount', ':webdav:', directory, '--webdav-url', url,
    '--webdav-vendor', 'other', '--config', '/dev/null', '--read-only',
    '--disable', 'About', // Finder's disk-space queries must not wait for the remote server.
    '--vfs-cache-mode', 'full', '--cache-dir', cacheDirectory, '--nfs-cache-type', 'memory',
    '--vfs-cache-max-size', '256M', '--vfs-cache-max-age', '30s', '--vfs-cache-poll-interval', '10s',
    '--vfs-cache-min-free-space', '2G', '--vfs-read-ahead', '0',
    '--buffer-size', '0', '--vfs-read-chunk-size', '1M', '--vfs-read-chunk-size-limit', '1M',
    '--dir-cache-time', '30s', '--poll-interval', '0', '--addr', '127.0.0.1:0',
    '--contimeout', '3s', '--timeout', '10s', '--low-level-retries', '1',
    '-o', 'ro,nosuid,nodev,noexec,soft,nolocks,rsize=262144,readahead=0,timeo=100,retrans=3,actimeo=1',
    '--log-file', logFile, '--log-level', 'ERROR', '--log-file-max-size', '1M', '--log-file-max-backups', '1'],
  { detached: true, stdio: 'ignore' })
  let failure
  child.on('error', error => { failure = error })
  child.on('exit', code => { failure ||= new Error(`Mount helper exited (${code}); see ${logFile}`) })
  child.unref()
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    state = { server: base, directory, pid: child.pid }
    await writeFile(stateFile, JSON.stringify(state) + '\n', { mode: 0o600 })
    for (let attempt = 0; attempt < 60; attempt++) {
      if (failure) throw failure
      mounted = await mountLine()
      if (mounted?.startsWith('localhost:/ on ') && mounted.includes('(nfs,')) {
        running = true
        const guard = spawn(process.execPath, [process.argv[1], 'drive', '_guard', '--to', directory, '--url', base, '--config', configPath], { detached: true, stdio: 'ignore' })
        await new Promise((resolve, reject) => { guard.once('spawn', resolve); guard.once('error', reject) })
        guard.unref()
        return report()
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error(`Mount timed out; see ${logFile}`)
  } catch (error) {
    child.kill('SIGTERM')
    await rm(stateFile, { force: true })
    throw error
  }
}
async function drive(command, operands) {
  if (['mount', 'unmount', 'status', 'refresh', '_guard'].includes(command)) return mountDrive(command)
  if (!['ls', 'tree', 'mkdir', 'download', 'bind', 'unbind', 'bindings', 'rename', 'move', 'rm'].includes(command)) throw new Error(`Unknown Drive command: ${command}`)
  if (command === 'bindings') return output({ server: base, bindings: bindings() })
  const chain = await locate(operands[0] || (['ls', 'tree'].includes(command) ? '/' : required(null, 'Remote path')), command === 'mkdir')
  const entry = chain.at(-1)
  if (command === 'ls' || command === 'tree') {
    folder(chain)
    const entries = []
    async function walk(current) {
      for (const item of (await list(current.at(-1).id)).entries) {
        const next = [...current, item]; entries.push({ ...item, path: remotePath(next) })
        if (command === 'tree' && item.kind === 'folder') await walk(next)
      }
    }
    await walk(chain)
    return output(options.json ? { path: remotePath(chain), entries } : entries.map(item => `${item.kind === 'folder' ? 'dir ' : 'file'}\t${item.id}\t${item.bytes}\t${item.path}`).join('\n'))
  }
  if (command === 'mkdir') return output({ entry, path: remotePath(chain) })
  if (command === 'bind' || command === 'unbind') {
    folder(chain)
    config.downloads ||= {}; config.downloads[base] ||= {}
    const key = String(entry.id ?? 'root')
    if (command === 'bind') config.downloads[base][key] = { remote: remotePath(chain), directory: localPath(required(operands[1], 'Local directory')) }
    else delete config.downloads[base][key]
    await saveConfig()
    return output({ server: base, folderId: entry.id, binding: config.downloads[base][key] || null })
  }
  if (command === 'download') {
    const chains = await Promise.all(operands.map(path => locate(path)))
    const ids = new Set(chains.map(chain => chain.at(-1).id))
    for (const target of chains.filter(chain => !chain.slice(0, -1).some(parent => ids.has(parent.id)))) await downloadEntry(target, options.to)
    return output({ downloaded: completed })
  }
  if (command === 'rename') {
    if (entry.id === null) throw new Error('The Drive root cannot be renamed')
    return output(await api(`/api/drive/entries/${entry.id}`, 'PATCH', { name: required(operands[1], 'New name') }))
  }
  if (command === 'move' || command === 'rm') {
    const parentId = command === 'move' ? folder(await locate(required(options.to, '--to'))).id : null
    for (const path of operands) {
      const target = (await locate(path)).at(-1)
      if (target.id === null) throw new Error('The Drive root cannot be moved or deleted')
      completed.push({ path, ...(await api(`/api/drive/entries/${target.id}`, command === 'move' ? 'PATCH' : 'DELETE', command === 'move' ? { parentId } : undefined)) })
    }
    return output({ results: completed })
  }
  throw new Error(`Unknown Drive command: ${command}`)
}
async function clipboard(command, operands) {
  if (!['list', 'put', 'upload', 'get', 'download', 'pin', 'unpin', 'rm'].includes(command)) throw new Error(`Unknown clipboard command: ${command}`)
  if (command === 'list') return output(await api(`/api/items?q=${encodeURIComponent(options.query || '')}`))
  if (command === 'put') {
    const chunks = []
    if (!operands.length) {
      if (process.stdin.isTTY) throw new Error('Provide text or pipe it to netclip clipboard put')
      for await (const chunk of process.stdin) chunks.push(chunk)
    }
    return output(await api('/api/items', 'POST', { text: operands.length ? operands.join(' ') : Buffer.concat(chunks).toString('utf8') }))
  }
  if (command === 'upload') {
    required(operands[0], 'Local file')
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' }
    for (const input of operands) {
      const path = localPath(input), info = await lstat(path)
      if (!info.isFile()) throw new Error(`Not a regular file: ${path}`)
      const source = createReadStream(path)
      try {
        const response = await request('/api/items/file', { method: 'POST', duplex: 'half', body: source,
          headers: { 'content-type': mime[extname(path).toLowerCase()] || 'application/octet-stream', 'content-length': String(info.size), 'x-filename': encodeURIComponent(basename(path)) } })
        completed.push(await response.json())
      } finally { source.destroy() }
    }
    return output({ results: completed })
  }
  const ids = operands.map(id => { if (!/^[1-9]\d*$/.test(id)) throw new Error(`Invalid item ID: ${id}`); return id })
  required(ids[0], 'Item ID')
  if (command === 'get' || command === 'download') {
    const { item } = await api(`/api/items/${ids[0]}`)
    if (command === 'get') return output(!options.json && item.kind === 'text' ? item.content : item)
    const name = item.filename || `netclip-${item.id}${item.kind === 'text' ? '.txt' : ''}`
    return output({ local: await saveFile(`/api/items/${item.id}/raw?download=1`, join(localPath(options.to || join(homedir(), 'Downloads', 'Netclip')), filename(name))) })
  }
  if (['pin', 'unpin', 'rm'].includes(command)) {
    for (const id of ids) completed.push({ id, result: await api(`/api/items/${id}`, command === 'rm' ? 'DELETE' : 'PATCH', command === 'rm' ? undefined : { pinned: command === 'pin' }) })
    return output({ results: completed })
  }
  throw new Error(`Unknown clipboard command: ${command}`)
}
async function main() {
  if (options.help || !args.length || args[0] === 'help') return process.stdout.write(HELP)
  try { config = JSON.parse(await readFile(configPath, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read ${configPath}: ${error.message}`); config = {} }
  base = serverUrl(options.url || process.env.NETCLIP_URL || config.url || 'http://localhost:3210')
  const [scope, command, ...operands] = args
  if (scope === 'config') {
    if (command) { config.url = serverUrl(command); await saveConfig(); base = config.url }
    return output({ configFile: configPath, server: base, downloads: bindings() })
  }
  if (scope === 'drive' && command === 'upload') {
    required(operands[0], 'Local file or folder')
    const chain = await locate(options.to || '/')
    const parent = folder(chain)
    for (const path of operands) await uploadPath(localPath(path), parent.id, remotePath(chain).replace(/\/$/, ''))
    return output({ uploaded: completed })
  }
  if (scope === 'drive') return drive(required(command, 'Drive command'), operands)
  if (scope === 'clipboard' || scope === 'clip') return clipboard(required(command, 'Clipboard command'), operands)
  throw new Error(`Unknown command: ${scope}. Run netclip --help.`)
}
main().catch(error => {
  process.stderr.write(options.json ? JSON.stringify({ error: error.message, status: error.status, completed }) + '\n' : `netclip: ${error.message}\n`)
  process.exitCode = 1
})
