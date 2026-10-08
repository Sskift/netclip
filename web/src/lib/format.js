import { t } from './i18n.js'

/**
 * Parses a URL only through the URL constructor with an explicit protocol allowlist —
 * never a regex. `javascript:` and `data:` never become clickable.
 */
export function safeUrl(text) {
  if (!text) return null
  const raw = text.trim()
  if (raw.length > 2048 || /\s/.test(raw)) return null
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url
  } catch {
    return null
  }
}

/** "github.com/anthropics/netclip" — the part of a URL a human actually recognises. */
export function prettyUrl(text) {
  const url = safeUrl(text)
  if (!url) return text
  const tail = (url.pathname === '/' ? '' : url.pathname) + url.search + url.hash
  return url.host.replace(/^www\./, '') + tail
}

export const typeLabel = (item) =>
  item.kind !== 'text' ? t(`kind.${item.kind}`) : t(`kind.${item.flavor || 'text'}`)

/** The one-line title a list row shows. */
export function titleOf(item) {
  if (item.kind !== 'text') return item.filename || t(`kind.${item.kind}`)
  if (item.flavor === 'url') return prettyUrl(item.content ?? item.preview)
  return item.preview || ' '
}

export const dimensions = (item) =>
  item.width && item.height ? `${item.width} × ${item.height}` : null

/**
 * Splits `text` around every case-insensitive occurrence of `query`, returning plain
 * strings and {match} markers. Rendering happens in React — never as an HTML string.
 */
export function highlight(text, query) {
  const q = (query || '').trim()
  if (!q || !text) return [{ text }]
  const haystack = text.toLowerCase()
  const needle = q.toLowerCase()
  const out = []
  let at = 0
  for (;;) {
    const hit = haystack.indexOf(needle, at)
    if (hit === -1) break
    if (hit > at) out.push({ text: text.slice(at, hit) })
    out.push({ text: text.slice(hit, hit + needle.length), match: true })
    at = hit + needle.length
  }
  if (!out.length) return [{ text }]
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}

/**
 * Unpinned rows fade as their lease runs down, so age is something you feel rather than
 * something you have to read. Floored so text never drops below a legible contrast.
 */
export function ageOpacity(item, now = Date.now()) {
  if (item.pinned || !item.expiresAt) return 1
  const total = item.expiresAt - item.updatedAt
  if (total <= 0) return 0.72
  const left = (item.expiresAt - now) / total
  return Math.max(0.72, Math.min(1, 0.72 + 0.28 * left))
}

// phoneUrl() returns a path-bearing origin, so strip the trailing slash — "host:3210//api"
// would be answered by the SPA fallback with a 200 and a page of HTML, which looks like
// success and does nothing.
export const terminalSnippet = (origin) =>
  `nclip() { pbpaste | curl -sT- ${String(origin).replace(/\/+$/, '')}/api/items; }`
