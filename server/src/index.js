import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { config } from './config.js'
import { handleApi } from './routes.js'
import { handleDrive } from './drive.js'
import { HttpError, json, serveStatic } from './http.js'
import { startSweeper, startup } from './cleanup.js'
import { closeAll } from './events.js'
import { close as closeDb } from './db.js'

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public')

const server = createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  } catch {
    return json(res, 400, { error: 'Bad request URL' })
  }

  try {
    if (url.pathname.startsWith('/api/drive/')) {
      await handleDrive(req, res, url)
      return
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url)
      return
    }
    if (config.dev) {
      // In dev the UI is served by Vite; anything non-API reaching here is a mistake.
      return json(res, 404, { error: 'Dev mode: the UI is served by Vite on :3211' })
    }
    const served = await serveStatic(req, res, PUBLIC_DIR, url.pathname)
    if (!served) return json(res, 404, { error: 'Not found' })
  } catch (err) {
    if (res.headersSent) return res.destroy()
    if (err instanceof HttpError) return json(res, err.status, { error: err.message })
    console.error('[netclip]', req.method, url.pathname, err)
    json(res, 500, { error: 'Internal error' })
  }
})

// Phones on flaky wifi leave half-open sockets around; don't hold them forever.
server.keepAliveTimeout = 65_000
server.headersTimeout = 70_000
// SSE streams must never be timed out by the server.
server.requestTimeout = 0

// Catch up on anything that expired while the box was off, and clear crash residue,
// before the first request can observe a stale list.
await startup()
const stopSweeper = startSweeper()

const days = (ms) => Math.round(ms / 86_400_000)

server.listen(config.port, config.host, () => {
  console.log(`[netclip] listening on http://${config.host}:${config.port}`)
  console.log(`[netclip] data dir ${config.dataDir}`)
  console.log(
    `[netclip] keeps text ${days(config.retention.text)}d · images ${days(config.retention.image)}d · ` +
      `max ${config.maxItems} items`,
  )
})

let closing = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) process.exit(0)
    closing = true
    console.log(`[netclip] ${sig} — shutting down`)
    stopSweeper()
    // Ending every SSE stream is what turns a 10s `docker stop` into a 200ms one.
    closeAll()
    server.close(() => {
      closeDb()
      process.exit(0)
    })
    setTimeout(() => {
      closeDb()
      process.exit(0)
    }, 3000).unref()
  })
}
