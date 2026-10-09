#!/usr/bin/env node
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, writeFile, mkdir, rename, rm, lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'

const HELP = `Netclip — shared clipboard and Drive CLI (Node 22+; no dependencies)

  netclip config [URL]                       Show config or save the server URL
  netclip drive ls [PATH]                    List a folder (default /)
  netclip drive tree [PATH]                  List a folder recursively
  netclip drive mkdir PATH                   Create folders, including parents
  netclip drive upload LOCAL... --to PATH    Upload files or whole folder trees
  netclip drive download PATH... [--to DIR]  Download files/folders, retaining structure
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
Environment: NETCLIP_URL, NETCLIP_CONFIG
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
async function drive(command, operands) {
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
