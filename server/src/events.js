/**
 * Dead-simple SSE fan-out. Every connected browser gets told the moment anything changes,
 * which is what makes "paste on the laptop, it's already on the phone" work.
 */
const clients = new Set()

export function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx and friends buffer SSE into uselessness without this
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 2000\n\n')
  res.write(`event: hello\ndata: {"ok":true}\n\n`)

  clients.add(res)
  const close = () => {
    clients.delete(res)
    res.end()
  }
  req.on('close', close)
  req.on('error', close)
  res.on('error', close)
}

export function broadcast(event, data) {
  if (!clients.size) return
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) {
    try {
      res.write(frame)
    } catch {
      clients.delete(res)
    }
  }
}

export const clientCount = () => clients.size

// Keeps intermediaries (and sleepy phone radios) from dropping an idle stream.
const heartbeat = setInterval(() => {
  for (const res of clients) {
    try {
      res.write(': ping\n\n')
    } catch {
      clients.delete(res)
    }
  }
}, 25_000)
heartbeat.unref()

export function closeAll() {
  clearInterval(heartbeat)
  for (const res of clients) {
    try {
      res.end()
    } catch {
      /* already gone */
    }
  }
  clients.clear()
}
