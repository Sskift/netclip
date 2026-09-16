/**
 * A human label for "where did this come from", derived from the User-Agent.
 * Not analytics — it's the difference between a list of anonymous rows and one where
 * you can see at a glance that a thing arrived from your phone.
 */
const OS = [
  [/iPhone/i, 'iPhone'],
  [/iPad/i, 'iPad'],
  [/Android/i, 'Android'],
  [/Mac OS X|Macintosh/i, 'Mac'],
  [/Windows/i, 'Windows'],
  [/CrOS/i, 'ChromeOS'],
  [/Linux/i, 'Linux'],
]

const BROWSER = [
  [/Edg\//i, 'Edge'],
  [/OPR\/|Opera/i, 'Opera'],
  [/Firefox\//i, 'Firefox'],
  [/CriOS\//i, 'Chrome'],
  [/Chrome\//i, 'Chrome'],
  [/Safari\//i, 'Safari'],
  [/curl\//i, 'curl'],
  [/Wget/i, 'wget'],
  [/HTTPie|python-requests|Go-http-client|axios|node-fetch|undici/i, 'API'],
]

const match = (table, ua) => table.find(([re]) => re.test(ua))?.[1]

export function deviceLabel(req) {
  const explicit = req.headers['x-netclip-device']
  if (typeof explicit === 'string' && explicit.trim()) {
    let decoded = explicit
    try {
      decoded = decodeURIComponent(explicit)
    } catch {
      // A bare '%' in the header is not worth failing a whole upload over.
    }
    return decoded.trim().slice(0, 40)
  }
  const ua = String(req.headers['user-agent'] || '')
  if (!ua) return 'API'
  const os = match(OS, ua)
  const browser = match(BROWSER, ua)
  if (browser === 'curl' || browser === 'wget' || browser === 'API') return browser
  if (os && browser) return `${os} · ${browser}`
  return os || browser || 'Unknown'
}
