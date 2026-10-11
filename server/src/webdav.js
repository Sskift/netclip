import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { SaxesParser } from 'saxes'
import { paths } from './config.js'
import { driveChildren, resolveDrivePath } from './drive.js'
import { HttpError, readBody } from './http.js'

const ALLOW = 'OPTIONS, PROPFIND, GET, HEAD'
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
const href = (names, entry) => `/dav/${names.map(encodeURIComponent).join('/')}${names.length && entry.kind === 'folder' ? '/' : ''}`
const etag = entry => `"${entry.blob_key}"` // Blobs are immutable; renaming does not change their bytes.

function sendXml(res, status, body) {
  const payload = Buffer.from(`<?xml version="1.0" encoding="utf-8"?>${body}`)
  res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': payload.length })
  res.end(payload)
}

function requestedProperties(body) {
  if (!body.trim()) return { mode: 'allprop', properties: [] }
  const parser = new SaxesParser({ xmlns: true }), stack = [], properties = []
  let mode
  parser.on('doctype', () => { throw new Error('DOCTYPE is not supported') })
  parser.on('opentag', tag => {
    if (!stack.length && (tag.uri !== 'DAV:' || tag.local !== 'propfind')) throw new Error('Expected DAV:propfind')
    if (stack.length === 1 && tag.uri === 'DAV:' && ['prop', 'propname', 'allprop'].includes(tag.local)) {
      if (mode) throw new Error('Use one property selection')
      mode = tag.local
    }
    if (stack.length === 2 && stack[1].uri === 'DAV:' && ['prop', 'include'].includes(stack[1].local)) {
      properties.push({ namespace: tag.uri, name: tag.local })
    }
    stack.push(tag)
  })
  parser.on('closetag', () => stack.pop())
  try { parser.write(body).close() } catch { throw new HttpError(400, 'Invalid PROPFIND XML') }
  if (!mode) throw new HttpError(400, 'Missing PROPFIND property selection')
  return { mode, properties }
}

function propResponse(entry, names, selection) {
  const isFolder = entry.kind === 'folder'
  const modified = isFolder ? driveChildren(entry.id).reduce((time, child) => Math.max(time, child.updated_at), entry.updated_at) : entry.updated_at
  const values = {
    displayname: xml(entry.name),
    resourcetype: isFolder ? '<D:collection/>' : '',
    creationdate: new Date(entry.created_at).toISOString(),
    getlastmodified: new Date(modified).toUTCString(),
    getcontentlength: String(entry.bytes),
    getcontenttype: isFolder ? 'httpd/unix-directory' : 'application/octet-stream',
    ...(isFolder ? {} : { getetag: xml(etag(entry)) }),
    supportedlock: '',
    lockdiscovery: '',
  }
  const known = Object.keys(values).map(name => ({ namespace: 'DAV:', name }))
  const requested = selection.mode === 'prop' ? selection.properties : [...known, ...selection.properties]
  const found = [], missing = []
  for (const { namespace, name } of requested) {
    if (namespace === 'DAV:' && Object.hasOwn(values, name)) {
      found.push(selection.mode === 'propname' ? `<D:${name}/>` : `<D:${name}>${values[name]}</D:${name}>`)
    } else {
      missing.push(`<${name} xmlns="${xml(namespace)}"/>`)
    }
  }
  const propstat = (props, status) => `<D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 ${status}</D:status></D:propstat>`
  return `<D:response><D:href>${xml(href(names, entry))}</D:href>${found.length || !missing.length ? propstat(found, '200 OK') : ''}${missing.length ? propstat(missing, '404 Not Found') : ''}</D:response>`
}

async function sendContent(req, res, entry) {
  let file
  try { file = await open(join(paths.drive, entry.blob_key), 'r') }
  catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, 'File not found'); throw error }
  try {
    const { size } = await file.stat(), tag = etag(entry), modified = new Date(entry.updated_at).toUTCString()
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': size,
      ETag: tag, 'Last-Modified': modified, 'Accept-Ranges': 'bytes' }
    if (req.headers['if-none-match']?.split(',').some(value => value.trim().replace(/^W\//, '') === tag || value.trim() === '*')) {
      res.writeHead(304, { ETag: tag }); res.end(); return
    }
    let start = 0, end = size - 1, status = 200
    const range = req.method === 'GET' && req.headers.range
    const ifRange = req.headers['if-range']
    const match = (!ifRange || ifRange === tag || ifRange === modified) && /^bytes=(\d*)-(\d*)$/.exec(range || '')
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
      end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }); res.end(); return
      }
      status = 206
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      headers['Content-Length'] = end - start + 1
    }
    res.writeHead(status, headers)
    if (req.method === 'HEAD' || size === 0) return res.end()
    await pipeline(file.createReadStream({ start, end, autoClose: false }), res)
  } finally { await file.close() }
}

// Class 1 WebDAV without LOCK mounts read-only on macOS. Keep mutations in the UI/CLI.
export async function handleWebDav(req, res, url) {
  res.setHeader('DAV', '1')
  res.setHeader('Allow', ALLOW)
  res.setHeader('Cache-Control', 'no-cache')
  if (req.method === 'OPTIONS') { res.writeHead(200, { 'Content-Length': 0 }); res.end(); return }
  if (!['PROPFIND', 'GET', 'HEAD'].includes(req.method)) {
    req.resume()
    throw new HttpError(405, 'This network drive is read-only; use the Netclip UI or CLI to make changes')
  }
  let names
  try {
    names = url.pathname.slice(4).replace(/^\//, '').replace(/\/$/, '').split('/').filter((part, index, all) => part || all.length > 1)
      .map(part => decodeURIComponent(part).normalize('NFC'))
    if (names.some(name => !name || name === '.' || name === '..' || /[/\\\u0000-\u001f\u007f]/.test(name))) throw new Error('Invalid name')
  } catch { throw new HttpError(400, 'Invalid Drive path') }
  const resolved = resolveDrivePath(names), { entry } = resolved
  if (req.method === 'PROPFIND') {
    const depth = req.headers.depth ?? 'infinity'
    if (depth === 'infinity') return sendXml(res, 403, '<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>')
    if (!['0', '1'].includes(depth)) throw new HttpError(400, 'Depth must be 0 or 1')
    const selection = requestedProperties((await readBody(req, 64 * 1024)).toString('utf8'))
    const responses = [propResponse(entry, resolved.names, selection)]
    if (depth === '1' && entry.kind === 'folder') {
      for (const child of driveChildren(entry.id)) responses.push(propResponse(child, [...resolved.names, child.name], selection))
    }
    return sendXml(res, 207, `<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`)
  }
  if (entry.kind === 'folder') { res.writeHead(200, { 'Content-Length': 0 }); res.end(); return }
  return sendContent(req, res, entry)
}
