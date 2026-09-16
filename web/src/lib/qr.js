import qrcode from 'qrcode-generator'

/**
 * Builds a single SVG path for a QR code. One <path> instead of hundreds of <rect>s keeps
 * the DOM small enough that rendering one inline in the preview pane costs nothing.
 */
export function qrPath(text, { errorCorrection = 'M' } = {}) {
  const qr = qrcode(0, errorCorrection) // 0 = pick the smallest version that fits
  qr.addData(text)
  qr.make()

  const count = qr.getModuleCount()
  let d = ''
  for (let row = 0; row < count; row++) {
    let run = 0
    for (let col = 0; col <= count; col++) {
      const dark = col < count && qr.isDark(row, col)
      if (dark) {
        run++
        continue
      }
      if (run) {
        d += `M${col - run} ${row}h${run}v1h-${run}z`
        run = 0
      }
    }
  }
  // 1 module of quiet zone on each side is enough for a phone camera at arm's length.
  const quiet = 2
  return { d, size: count, viewBox: `-${quiet} -${quiet} ${count + quiet * 2} ${count + quiet * 2}` }
}

const isLoopback = () => {
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')
}

/**
 * The URL a phone should open. The address bar is the source of truth — it is by
 * definition an address that reached this server. Only when the app was opened on
 * localhost (where that address means "this machine") do we fall back to a LAN address
 * the server detected for itself.
 */
export function phoneUrl(info, path = '/') {
  const { protocol, port, origin } = window.location
  if (!isLoopback()) return origin + path

  const lan = info?.lanAddresses?.[0]
  if (!lan) return origin + path
  const p = port ? `:${port}` : ''
  return `${protocol}//${lan}${p}${path}`
}

/**
 * True when the address we'd put in a QR code is one no phone can reach — i.e. we're on
 * localhost and the server could only see a container-internal address for itself.
 * Better to say "open this page by its LAN address first" than to hand someone a code
 * that scans perfectly and then times out.
 */
export function phoneUrlIsUseless(info) {
  if (!isLoopback()) return false
  return !info || info.lanReachable !== true
}
