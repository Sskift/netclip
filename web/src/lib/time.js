/** Time formatting, localised for free by Intl rather than by a hand-written dictionary. */

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

let locale = typeof navigator !== 'undefined' ? navigator.language : 'en'
export const setTimeLocale = (l) => {
  locale = l
  cache.clear()
}

const cache = new Map()
const fmt = (key, make) => {
  if (!cache.has(key)) cache.set(key, make())
  return cache.get(key)
}
const rtf = () => fmt('rtf', () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' }))
const rtfLong = () => fmt('rtfLong', () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }))
const shortDate = () => fmt('date', () => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }))
const fullDate = () =>
  fmt('full', () =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
  )

/** "now", "3 min. ago", "2 hr. ago", "yesterday", "Mar 4" */
export function relativeTime(ts, now = Date.now()) {
  const diff = now - ts
  if (diff < 45_000) return relativeNow()
  if (diff < HOUR) return rtf().format(-Math.round(diff / MIN), 'minute')
  if (diff < DAY) return rtf().format(-Math.round(diff / HOUR), 'hour')
  if (diff < 7 * DAY) return rtf().format(-Math.round(diff / DAY), 'day')
  return shortDate().format(ts)
}

// Intl has no "now"; borrow the 0-second form, which localises to "now" / "现在".
const relativeNow = () => rtf().format(0, 'second').replace(/^in /, '')

export const absoluteTime = (ts) => fullDate().format(ts)

/**
 * Which section header a row belongs under. Boundaries are computed with calendar
 * arithmetic rather than by subtracting 24-hour multiples, so a clock change doesn't push
 * rows into the wrong section for a day.
 */
export function dayGroup(ts, now = Date.now()) {
  const midnightDaysAgo = (n) => {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - n)
    return d.getTime()
  }
  if (ts >= midnightDaysAgo(0)) return 'today'
  if (ts >= midnightDaysAgo(1)) return 'yesterday'
  if (ts >= midnightDaysAgo(7)) return 'week'
  return 'older'
}

/** "expires in 6 days" — the phrasing that makes expiry feel like weather, not deletion. */
export function expiresIn(expiresAt, now = Date.now()) {
  if (!expiresAt) return null
  const left = expiresAt - now
  if (left <= 0) return rtfLong().format(0, 'minute')
  if (left < HOUR) return rtfLong().format(Math.max(1, Math.round(left / MIN)), 'minute')
  if (left < DAY) return rtfLong().format(Math.round(left / HOUR), 'hour')
  return rtfLong().format(Math.round(left / DAY), 'day')
}

export function formatBytes(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
