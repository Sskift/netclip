export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

async function request(path, options = {}) {
  let res
  try {
    res = await fetch(path, options)
  } catch {
    throw new ApiError('Can’t reach netclip — is the server still running?', 0)
  }
  if (res.status === 204) return null
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) throw new ApiError(body?.error || `Request failed (${res.status})`, res.status)
  return body
}

export const getInfo = () => request('/api/info')

export const listItems = (query = '', signal) =>
  request(`/api/items?q=${encodeURIComponent(query)}`, { signal }).then((r) => r.items)

export const getItem = (id) => request(`/api/items/${id}`).then((r) => r.item)

export const addText = (text) =>
  request('/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })

export const addFile = (file) =>
  request('/api/items/file', {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      ...(file.name ? { 'x-filename': encodeURIComponent(file.name) } : {}),
    },
    body: file,
  })

export const setPinned = (id, pinned) =>
  request(`/api/items/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pinned }),
  }).then((r) => r.item)

export const deleteItem = (id) => request(`/api/items/${id}`, { method: 'DELETE' })

/**
 * Fire-and-forget, sent *after* the synchronous copy so it can never sit in the user
 * gesture's path. Renews the item's lease server-side: things you use don't age out.
 */
export const markCopied = (id) =>
  fetch(`/api/items/${id}/copy`, { method: 'POST', keepalive: true }).catch(() => {})

/** Used when the tab is going away and a deferred delete still hasn't fired. */
export const deleteItemBeacon = (id) =>
  fetch(`/api/items/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {})

export const clearUnpinned = () => request('/api/items', { method: 'DELETE' })

export const rawUrl = (item, { download = false } = {}) =>
  `/api/items/${item.id}/raw${download ? '?download=1' : ''}`
export const thumbUrl = (item) => (item.hasThumb ? `/api/items/${item.id}/thumb` : rawUrl(item))

/**
 * Live updates. EventSource reconnects on its own, so the only thing we have to handle is
 * "we were away for a while" — the caller resyncs on every `open` after the first.
 */
export function connectEvents({ onEvent, onStatus }) {
  let source
  let closed = false
  let opened = 0
  let retry = null
  let backoff = 1000

  const connect = () => {
    if (closed) return
    source = new EventSource('/api/events')

    source.addEventListener('open', () => {
      backoff = 1000
      onStatus?.(opened++ === 0 ? 'live' : 'resynced')
    })

    source.addEventListener('error', () => {
      onStatus?.('reconnecting')
      // EventSource retries transient failures itself, but a hard failure (server gone,
      // a non-2xx response) closes it for good — and then live updates are silently dead
      // forever with the UI stuck on "reconnecting". Restart it ourselves.
      if (source.readyState === EventSource.CLOSED && !closed) {
        clearTimeout(retry)
        retry = setTimeout(connect, backoff)
        backoff = Math.min(backoff * 2, 15_000)
      }
    })

    for (const type of ['created', 'updated', 'deleted', 'purged']) {
      source.addEventListener(type, (e) => {
        try {
          onEvent(type, JSON.parse(e.data))
        } catch {
          /* ignore malformed frame */
        }
      })
    }
  }
  connect()

  return () => {
    closed = true
    clearTimeout(retry)
    source?.close()
  }
}
