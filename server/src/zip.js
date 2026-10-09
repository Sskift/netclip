import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import { contentDisposition } from './http.js'

// Stream one file at a time; neither the server nor browser buffers the whole archive.
export async function sendZip(req, res, entries, filename) {
  const zip = new yazl.ZipFile()
  let current
  zip.on('error', (error) => zip.outputStream.destroy(error))
  for (const entry of entries) {
    const options = { mtime: new Date(entry.updatedAt) }
    if (!entry.source) zip.addEmptyDirectory(entry.path, options)
    else zip.addReadStreamLazy(entry.path, { ...options, size: entry.bytes, compress: false }, (done) => {
      if (res.destroyed) return done(new Error('Download cancelled'))
      current = createReadStream(entry.source)
      done(null, current)
    })
  }
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': contentDisposition(filename, false),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  if (req.method === 'HEAD') { zip.outputStream.destroy(); return res.end() }
  zip.end()
  try { await pipeline(zip.outputStream, res) }
  catch { res.destroy() }
  finally { current?.destroy(); zip.outputStream.destroy() }
}
