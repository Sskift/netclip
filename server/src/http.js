import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { extname, join, normalize } from 'node:path'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

export function noContent(res) {
  res.writeHead(204)
  res.end()
}

export const contentDisposition = (filename, inline) => {
  const ascii = filename.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7e]/g, '_')
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** Sends an in-memory payload with the same disposition/caching rules as sendFile. */
export function sendBuffer(req, res, buf, { contentType, cacheControl, filename, inline = true } = {}) {
  const headers = {
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': cacheControl || 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  if (filename) headers['Content-Disposition'] = contentDisposition(filename, inline)
  res.writeHead(200, headers)
  if (req.method === 'HEAD') return res.end()
  res.end(buf)
}

/** Buffers the request body, refusing anything over `limit` without reading it all. */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      return reject(new HttpError(413, `Too large (${fmtBytes(declared)}, limit ${fmtBytes(limit)})`))
    }
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, `Too large (limit ${fmtBytes(limit)})`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

/** Streams a file with an ETag, or returns false if it isn't there. */
export async function sendFile(
  req,
  res,
  path,
  { contentType, cacheControl, filename, inline = true, headers: extra } = {},
) {
  let info
  try {
    info = await stat(path)
    if (!info.isFile()) return false
  } catch {
    return false
  }

  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`
  const headers = {
    'Content-Type': contentType || MIME[extname(path).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': cacheControl || 'no-cache',
    ETag: etag,
    ...extra,
  }
  if (filename) headers['Content-Disposition'] = contentDisposition(filename, inline)

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': headers['Cache-Control'] })
    res.end()
    return true
  }

  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return true
  }

  // pipeline(), not .pipe(). Legacy .pipe() attaches an error handler to the destination
  // only and never destroys the source, so two things go wrong with a bare pipe here:
  // a phone that drops wifi mid-image leaks the file descriptor forever, and a blob the
  // sweeper unlinks between our stat() and the open() emits an 'error' with no listener,
  // which takes the whole process down.
  try {
    await pipeline(createReadStream(path), res)
  } catch {
    // Client went away, or the file vanished under us. Either way there is nothing left
    // to say — the headers are already sent.
    res.destroy()
  }
  return true
}

/** Serves the built SPA: hashed assets cached forever, index.html never. */
export async function serveStatic(req, res, root, pathname) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  const target = join(root, rel)
  if (!target.startsWith(root)) return false

  if (rel !== '/' && !rel.endsWith('/')) {
    const immutable = /\/assets\/.+-[A-Za-z0-9_-]{8,}\.\w+$/.test(rel)
    const sent = await sendFile(req, res, target, {
      cacheControl: immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    if (sent) return true
  }

  // SPA fallback — any unknown path renders the app.
  return sendFile(req, res, join(root, 'index.html'), { cacheControl: 'no-cache' })
}
