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
  netclip migrate --to HOST [--from HOST]    Copy Drive and all history over SSH
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
Migration: HOST is an SSH alias / user@host, or local (--from defaults to local).
  --source-container NAME, --target-container NAME   Docker containers (default netclip)
  --source-dir DIR, --target-dir DIR                 Use data directories instead
  --stopped          Required for directory endpoints; stop their servers first
  --replace          Replace nonempty target data, retaining a backup
Docker endpoints must already exist; running containers are stopped and restarted.
Directory endpoints need Node 22.13+ on PATH. SSH uses your normal ~/.ssh/config.
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
  netclip migrate --from old-server --to new-server
  printf 'ready' | netclip clipboard put --json
`

let options, args
try {
  ;({ values: options, positionals: args } = parseArgs({ allowPositionals: true, options: {
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    url: { type: 'string' }, config: { type: 'string' }, to: { type: 'string' }, query: { type: 'string' },
    from: { type: 'string' }, 'source-container': { type: 'string' }, 'target-container': { type: 'string' },
    'source-dir': { type: 'string' }, 'target-dir': { type: 'string' },
    stopped: { type: 'boolean' }, replace: { type: 'boolean' },
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
// This worker is serialized over SSH, keeping the installed CLI a single file.
// Only standard Node modules are needed on either endpoint (or inside its image).
async function migrationWorker(settings) {
  const fs = await import('node:fs/promises')
  const { createReadStream } = await import('node:fs')
  const { join, resolve, dirname } = await import('node:path')
  const { homedir } = await import('node:os')
  const { createHash } = await import('node:crypto')
  const { once } = await import('node:events')
  const { DatabaseSync } = await import('node:sqlite')
  const { action, token, docker, replace } = settings
  const requested = resolve(settings.directory === '~' ? homedir() : settings.directory.startsWith('~/') ? join(homedir(), settings.directory.slice(2)) : settings.directory)
  await fs.mkdir(requested, { recursive: true })
  if (!(await fs.lstat(requested)).isDirectory()) throw new Error('Use a real data directory, not a symlink')
  const root = await fs.realpath(requested)
  const lock = join(root, '.netclip-migration-lock')
  const stage = join(root, `.netclip-migrate-${token}`)
  const backup = join(root, `.netclip-backup-${token}`)
  const names = ['netclip.db', 'netclip.db-wal', 'netclip.db-shm', 'blobs', 'thumbs', 'drive', 'tmp']
  const info = async path => { try { return await fs.lstat(path) } catch (e) { if (e.code !== 'ENOENT') throw e; return null } }
  const json = async path => JSON.parse(await fs.readFile(path, 'utf8'))
  const save = async (path, value) => {
    const file = await fs.open(path + '.tmp', 'w', 0o600)
    try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
    await fs.rename(path + '.tmp', path)
  }
  const regular = async (path, bytes) => {
    const stat = await info(path)
    if (!stat?.isFile() || (bytes !== undefined && stat.size !== bytes)) throw new Error(`Missing or invalid file: ${path}`)
  }
  const safePath = path => typeof path === 'string' && path.length <= 4096 && !/[\\\0]/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..') &&
    (['netclip.db', 'netclip.db-wal', 'netclip.db-shm'].includes(path) || /^(blobs|thumbs|drive)(\/|$)/.test(path))
  async function inspectData(directory, validateFiles = false) {
    await regular(join(directory, 'netclip.db'))
    const db = new DatabaseSync(join(directory, 'netclip.db'), { readOnly: true })
    try {
      if (validateFiles) {
        if (db.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok')) throw new Error('SQLite integrity check failed')
        if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite foreign key check failed')
      }
      const history = db.prepare('SELECT COUNT(*) AS n FROM items').get().n
      const drive = db.prepare('SELECT COUNT(*) AS n FROM drive_entries').get().n
      if (validateFiles) {
        for (const row of db.prepare("SELECT hash, bytes, has_thumb FROM items WHERE kind != 'text'").iterate()) {
          if (!/^[0-9a-f]{64}$/.test(row.hash)) throw new Error('Invalid clipboard blob hash')
          await regular(join(directory, 'blobs', row.hash.slice(0, 2), row.hash), row.bytes)
          if (row.has_thumb) await regular(join(directory, 'thumbs', row.hash.slice(0, 2), row.hash + '.webp'))
        }
        for (const row of db.prepare("SELECT blob_key, bytes FROM drive_entries WHERE kind = 'file'").iterate()) {
          if (typeof row.blob_key !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(row.blob_key)) throw new Error('Invalid Drive blob key')
          await regular(join(directory, 'drive', row.blob_key), row.bytes)
        }
      }
      return { history, drive }
    } finally { db.close() }
  }
  async function checkTarget() {
    if (replace) return
    if (await info(join(root, 'netclip.db'))) {
      const counts = await inspectData(root)
      if (counts.history || counts.drive) throw new Error('Target contains Drive or history data; use --replace to retain a backup and replace it')
    }
    async function empty(path) {
      const stat = await info(path)
      if (!stat) return
      if (!stat.isDirectory()) throw new Error('Target contains files; use --replace to retain a backup and replace them')
      for (const name of await fs.readdir(path)) await empty(join(path, name))
    }
    for (const name of ['blobs', 'thumbs', 'drive', 'tmp']) await empty(join(root, name))
  }
  if (root === dirname(root)) throw new Error('The filesystem root cannot be a data directory')
  if (action === 'prepare') {
    await fs.mkdir(lock, { mode: 0o700 }).catch(e => { if (e.code === 'EEXIST') throw new Error(`Migration already locked: ${lock}`); throw e })
    await save(join(lock, 'owner.json'), { token })
  }
  if (!await info(lock)) {
    if (['release', 'rollback'].includes(action)) return { directory: root }
    throw new Error('Migration lock is missing')
  }
  if ((await json(join(lock, 'owner.json'))).token !== token) {
    if (['release', 'rollback'].includes(action)) return { directory: root }
    throw new Error(`Another migration owns ${lock}`)
  }
  // Docker reuses one helper name, so its daemon serializes worker invocations.
  // Native workers also check a PID lock before recovery after a dropped SSH link.
  const busy = join(lock, 'busy.json')
  if (!docker) {
    for (let i = 0; await info(busy); i++) {
      const { pid } = await json(busy)
      let alive = true
      try { process.kill(pid, 0) } catch (e) { if (e.code === 'ESRCH') alive = false; else throw e }
      if (!alive) break
      if (i === 40) throw new Error(`Worker ${pid} is still active; keep the server stopped and retain ${lock}`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  await save(busy, { pid: process.pid })
  try {
    if (action === 'prepare') {
      if (settings.role === 'source') await regular(join(root, 'netclip.db'))
      else await checkTarget()
      return { directory: root, backup }
    }
    if (action === 'export') {
      const write = async data => { if (!process.stdout.write(data)) await once(process.stdout, 'drain') }
      const record = value => write(JSON.stringify(value) + '\n')
      let files = 0, bytes = 0
      await record({ format: 'netclip-migration', version: 1 })
      async function walk(path) {
        if (!safePath(path)) throw new Error(`Invalid storage path: ${path}`)
        const absolute = join(root, path), stat = await fs.lstat(absolute)
        if (stat.isDirectory()) {
          await record({ type: 'directory', path })
          for (const name of (await fs.readdir(absolute)).sort()) await walk(path + '/' + name)
        } else if (stat.isFile()) {
          await record({ type: 'file', path, bytes: stat.size })
          const hash = createHash('sha256')
          let size = 0
          for await (const chunk of createReadStream(absolute)) { hash.update(chunk); size += chunk.length; await write(chunk) }
          if (size !== stat.size) throw new Error(`Source changed during migration: ${path}`)
          await record({ type: 'checksum', sha256: hash.digest('hex') })
          files++; bytes += size
        } else throw new Error(`Symlinks and special files cannot be migrated: ${path}`)
      }
      for (const name of names.filter(name => name !== 'tmp')) if (await info(join(root, name))) await walk(name)
      await record({ type: 'end', files, bytes })
      return
    }
    if (action === 'receive') {
      await fs.mkdir(stage, { mode: 0o700 })
      const input = process.stdin[Symbol.asyncIterator]()
      let buffer = Buffer.alloc(0), ended = false, files = 0, bytes = 0
      async function fill() {
        if (buffer.length) return true
        const next = await input.next()
        if (next.done) { ended = true; return false }
        buffer = next.value
        return true
      }
      async function record() {
        const chunks = []; let size = 0
        while (await fill()) {
          const newline = buffer.indexOf(10), take = newline < 0 ? buffer.length : newline
          chunks.push(buffer.subarray(0, take)); size += take
          if (size > 16384) throw new Error('Migration header is too large')
          buffer = buffer.subarray(take + (newline >= 0 ? 1 : 0))
          if (newline >= 0) return JSON.parse(Buffer.concat(chunks).toString('utf8'))
        }
        throw new Error('Incomplete migration stream')
      }
      const header = await record()
      if (header.format !== 'netclip-migration' || header.version !== 1) throw new Error('Unsupported migration stream')
      const seen = new Set()
      while (!ended) {
        const entry = await record()
        if (entry.type === 'end') {
          if (entry.files !== files || entry.bytes !== bytes || await fill()) throw new Error('Migration stream length mismatch')
          break
        }
        if (!safePath(entry.path) || seen.has(entry.path)) throw new Error('Invalid or duplicate migration path')
        seen.add(entry.path)
        const path = join(stage, entry.path)
        if (entry.type === 'directory') await fs.mkdir(path, { mode: 0o700 })
        else if (entry.type === 'file' && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0) {
          const file = await fs.open(path, 'wx', 0o600), hash = createHash('sha256')
          try {
            let remaining = entry.bytes
            while (remaining) {
              if (!await fill()) throw new Error(`Incomplete migration file: ${entry.path}`)
              const chunk = buffer.subarray(0, Math.min(remaining, buffer.length))
              buffer = buffer.subarray(chunk.length); remaining -= chunk.length
              hash.update(chunk); await file.writeFile(chunk)
            }
            await file.sync()
          } finally { await file.close() }
          const checksum = await record()
          if (checksum.type !== 'checksum' || checksum.sha256 !== hash.digest('hex')) throw new Error(`Checksum mismatch: ${entry.path}`)
          files++; bytes += entry.bytes
        } else throw new Error('Invalid migration entry')
      }
      const counts = await inspectData(stage, true)
      await save(join(lock, 'ready.json'), { ...counts, files, bytes })
      return { ...counts, files, bytes }
    }
    if (action === 'commit') {
      const counts = await json(join(lock, 'ready.json'))
      await checkTarget() // Recheck after stopping the target; it may have received new data.
      const old = [], incoming = await fs.readdir(stage)
      for (const name of names) if (await info(join(root, name))) old.push(name)
      await fs.mkdir(backup, { mode: 0o700 })
      await save(join(lock, 'journal.json'), { old, incoming })
      for (const name of old) await fs.rename(join(root, name), join(backup, name))
      // A target image may run under a different UID than the source image.
      const owner = await fs.stat(backup + (old.includes('netclip.db') ? '/netclip.db' : '/..'))
      async function ownership(path) {
        if ((await fs.lstat(path)).isDirectory()) for (const name of await fs.readdir(path)) await ownership(join(path, name))
        if (process.getuid?.() === 0) await fs.chown(path, owner.uid, owner.gid)
      }
      for (const name of incoming) { await ownership(join(stage, name)); await fs.rename(join(stage, name), join(root, name)) }
      return { ...counts, directory: root, backup }
    }
    if (action === 'rollback' && await info(join(lock, 'journal.json'))) {
      const { old, incoming } = await json(join(lock, 'journal.json'))
      for (const name of incoming.filter(name => !old.includes(name))) {
        if (!await info(join(stage, name))) await fs.rm(join(root, name), { recursive: true, force: true })
      }
      for (const name of old) {
        if (!await info(join(backup, name))) continue
        await fs.rm(join(root, name), { recursive: true, force: true })
        await fs.rename(join(backup, name), join(root, name))
      }
      await fs.rm(backup, { recursive: true, force: true })
    }
    if (['release', 'rollback'].includes(action)) {
      await fs.rm(stage, { recursive: true, force: true })
      await fs.rm(lock, { recursive: true, force: true })
      return { directory: root }
    }
    throw new Error(`Unknown migration action: ${action}`)
  } finally { await fs.rm(busy, { force: true }) }
}

async function migrate() {
  const id = randomUUID(), children = new Set()
  let interrupted = false
  const log = message => { if (!options.json) process.stderr.write(`netclip: ${message}\n`) }
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
  function endpoint(role, host) {
    if (host !== 'local' && (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]*$/.test(host) || host.includes('..@'))) throw new Error(`Invalid SSH host: ${host}; use an alias from ~/.ssh/config`)
    const directory = options[`${role}-dir`], container = options[`${role}-container`] || 'netclip'
    if (directory && options[`${role}-container`]) throw new Error(`Choose --${role}-dir or --${role}-container`)
    if (directory && !options.stopped) throw new Error('Stop directory-based servers first, then pass --stopped (Docker servers are managed automatically)')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) throw new Error('Invalid container name')
    if (directory && !directory.startsWith('/') && !directory.startsWith('~/')) throw new Error(`--${role}-dir must be an absolute path or start with ~/`)
    return { role, host, directory, container, docker: !directory, token: `${id}-${role}`, helper: `netclip-migrate-${id}-${role}` }
  }
  const source = endpoint('source', options.from || 'local'), target = endpoint('target', required(options.to, '--to SSH host'))
  function launch(endpoint, argv, stream = false) {
    const remote = endpoint.host !== 'local'
    const child = spawn(remote ? 'ssh' : argv[0], remote ?
      ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '--', endpoint.host, argv.map(quote).join(' ')] : argv.slice(1),
    { stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    let stdout = '', stderr = ''
    if (!stream) child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill() })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384) })
    child.stdin.on('error', () => {})
    child.done = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        children.delete(child)
        if (code === 0) resolve(stdout.trim())
        else reject(new Error(`${endpoint.host} (${endpoint.role}): ${stderr.trim() || `${argv[0]} exited ${code ?? signal}`}`))
      })
    })
    child.done.catch(() => {})
    return child
  }
  async function run(endpoint, argv) { const child = launch(endpoint, argv); child.stdin.end(); return child.done }
  function worker(endpoint, action, stream = false) {
    const script = `(${migrationWorker.toString()})(${JSON.stringify({ ...endpoint, action, replace: Boolean(options.replace) })}).then(value=>{if(value)process.stdout.write(JSON.stringify(value)+'\\n')}).catch(error=>{process.stderr.write(error.message+'\\n');process.stdin.destroy();process.exitCode=1})`
    return launch(endpoint, endpoint.docker ? ['docker', 'run', '--rm', '-i', '--network', 'none', '--name', endpoint.helper,
      '--volumes-from', endpoint.container, '--user', '0', '--entrypoint', 'node', endpoint.image, '-e', script] : ['node', '-e', script], stream)
  }
  async function call(endpoint, action) { const child = worker(endpoint, action); child.stdin.end(); return JSON.parse(await child.done) }
  async function preflight(endpoint) {
    if (endpoint.docker) {
      const [data] = JSON.parse(await run(endpoint, ['docker', 'inspect', endpoint.container]))
      if (!['running', 'exited', 'created'].includes(data.State.Status)) throw new Error(`${endpoint.host}: container must be running or stopped, not ${data.State.Status}`)
      const env = data.Config.Env || []
      endpoint.directory = env.find(value => value.startsWith('NETCLIP_DATA_DIR='))?.slice(17) || '/data'
      if (!endpoint.directory.startsWith('/')) throw new Error('Docker NETCLIP_DATA_DIR must be absolute')
      const mount = data.Mounts.find(mount => mount.Destination === endpoint.directory)
      if (!mount?.RW || data.Mounts.some(mount => mount.Destination.startsWith(endpoint.directory + '/'))) throw new Error(`${endpoint.host}: data directory must be one writable Docker volume or bind mount`)
      if (data.HostConfig.AutoRemove) throw new Error('Cannot migrate an auto-remove Docker container')
      const users = (await run(endpoint, ['docker', 'ps', '--no-trunc', '-q', '--filter', `volume=${mount.Name || mount.Source}`])).split('\n').filter(Boolean)
      if (users.some(container => container !== data.Id)) throw new Error(`${endpoint.host}: another running container shares the data mount; stop it before migrating`)
      endpoint.image = data.Image
      endpoint.running = data.State.Running
      endpoint.port = env.find(value => value.startsWith('PORT='))?.slice(5) || env.find(value => value.startsWith('NETCLIP_PORT='))?.slice(13) || '3210'
    }
    endpoint.prepared = true // Cleanup also covers a lost reply after the lock was created.
    const result = await call(endpoint, 'prepare')
    endpoint.directory = result.directory
    endpoint.backup = result.backup
  }
  async function stop(endpoint) {
    if (endpoint.docker && endpoint.running) {
      endpoint.stopped = true
      await run(endpoint, ['docker', 'stop', '--time', '15', endpoint.container])
    }
  }
  async function restart(endpoint) {
    if (!endpoint.stopped) return
    await run(endpoint, ['docker', 'start', endpoint.container])
    endpoint.stopped = false
    const probe = `let ok=false;for(let i=0;i<30;i++){try{const r=await fetch('http://127.0.0.1:${Number(endpoint.port)}/api/health',{signal:AbortSignal.timeout(1000)});if(r.ok){ok=true;break}}catch{}await new Promise(r=>setTimeout(r,500))}if(!ok)process.exit(1)`
    await run(endpoint, ['docker', 'exec', endpoint.container, 'node', '--input-type=module', '-e', probe])
  }
  const cancel = () => { interrupted = true; for (const child of children) child.kill('SIGTERM') }
  const checkCancelled = () => { if (interrupted) throw new Error('Migration interrupted') }
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel)
  let result, committed = false, success = false
  try {
    log(`Checking ${source.host} → ${target.host}…`)
    await preflight(source); checkCancelled()
    await preflight(target); checkCancelled()
    log('Stopping source and transferring Drive, history and attachments…')
    await stop(source); checkCancelled()
    const receiver = worker(target, 'receive'), sender = worker(source, 'export', true)
    sender.stdin.end()
    try {
      await Promise.all([pipeline(sender.stdout, receiver.stdin), sender.done, receiver.done])
    } catch (error) { sender.kill(); receiver.kill(); await Promise.allSettled([sender.done, receiver.done]); throw error }
    result = JSON.parse(await receiver.done)
    checkCancelled()
    await restart(source); checkCancelled()
    log(`Verified ${result.history} history items and ${result.drive} Drive entries; switching target data…`)
    await stop(target); checkCancelled()
    committed = true // Includes an uncertain reply after a successful remote commit.
    result = await call(target, 'commit'); checkCancelled()
    await restart(target); checkCancelled()
    success = true
  } catch (error) {
    if (interrupted) error.message = `Migration interrupted. ${error.message}`
    throw error
  } finally {
    // Finish recovery even when the user interrupts a long transfer.
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel)
    const failures = []
    for (const endpoint of [target, source]) {
      if (!endpoint.prepared) continue
      try {
        if (endpoint.docker) await run(endpoint, ['docker', 'rm', '-f', endpoint.helper]).catch(() => {})
        if (!success && committed && endpoint === target) await stop(target)
        await call(endpoint, !success && endpoint === target ? 'rollback' : 'release')
        if (!success) await restart(endpoint)
      } catch (error) { failures.push(`${endpoint.host}: ${error.message}; retain ${endpoint.directory}/.netclip-migration-lock and ${endpoint.backup || 'the backup directory'} for recovery`) }
    }
    if (failures.length) throw new Error(`${success ? 'Data migrated, but cleanup failed' : 'Migration failed and needs recovery'}: ${failures.join('; ')}`)
  }
  return { migrated: true, source: { host: source.host, directory: source.directory }, target: { host: target.host, directory: target.directory }, ...result }
}

async function main() {
  if (options.help || !args.length || args[0] === 'help') return process.stdout.write(HELP)
  if (args[0] === 'migrate') {
    if (args.length !== 1) throw new Error('Use netclip migrate --from HOST --to HOST')
    return output(await migrate())
  }
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
