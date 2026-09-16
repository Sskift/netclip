/**
 * Copying, on a network where nothing is HTTPS.
 *
 * netclip is opened as http://192.168.x.x:3210, which is not a secure context. That single
 * fact decides almost everything in this file, and the rules below are load-bearing:
 *
 *  1. `navigator.clipboard` is not "blocked", it is UNDEFINED. So a
 *     `navigator.clipboard.writeText(t).catch(fallback)` never reaches the fallback — the
 *     TypeError is thrown while evaluating the expression, before any promise exists.
 *     Every access is therefore guarded by an explicit secure-context check.
 *  2. `document.execCommand('copy')` is NOT secure-context gated and still ships in every
 *     current browser, so it is the real copy path. It only works when called
 *     *synchronously inside a user gesture* — nothing in this file may await before it.
 *  3. Putting an IMAGE on the clipboard programmatically is impossible on http, in every
 *     browser, with no fallback: ClipboardItem is secure-context only, and the legacy
 *     `copy` event's setData() takes strings only. The native long-press menu on the
 *     <img> is the only mechanism that exists — see the CSS contract in styles.css.
 */

export const isSecure = () => window.isSecureContext === true

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

export const isAndroid = () => /Android/.test(navigator.userAgent)
export const isTouch = () => matchMedia('(hover: none) and (pointer: coarse)').matches
/** WeChat's webview offers 保存图片 but no Copy at all — worth saying out loud. */
export const isWeChat = () => /MicroMessenger/i.test(navigator.userAgent)

/**
 * What this browser can actually do, probed once at boot so the UI never renders a
 * control that would silently do nothing.
 */
export const capabilities = {
  secure: isSecure(),
  ios: isIOS(),
  android: isAndroid(),
  touch: isTouch(),
  wechat: isWeChat(),
  // Real image-to-clipboard. Essentially always false on a LAN.
  copyImage: isSecure() && typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write,
  // Reading the user's clipboard. Impossible on http — there is no legacy fallback at all.
  readClipboard: isSecure() && !!navigator.clipboard?.readText,
  // The share sheet. Secure-context gated, so also absent on a LAN.
  share: isSecure() && typeof navigator.share === 'function',
}

/**
 * Selects the contents of a throwaway element and asks the browser to copy them.
 *
 * A <span> with `white-space: pre`, not a <textarea>: textareas are where the iOS
 * selection bugs live, and a Range over a span behaves identically on every browser.
 * The element must be *rendered* (not display:none, not opacity:0) for the selection to
 * take, so it is hidden with the standard clip/inset technique instead.
 */
function execCopy(text) {
  const span = document.createElement('span')
  span.textContent = text
  span.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'width:1px',
    'height:1px',
    'padding:0',
    'border:0',
    'overflow:hidden',
    'clip:rect(0 0 0 0)',
    'clip-path:inset(50%)',
    'white-space:pre', // keeps newlines and runs of spaces intact
    'user-select:text',
    '-webkit-user-select:text',
  ].join(';')

  document.body.appendChild(span)

  const selection = window.getSelection()
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  let ok = false
  try {
    const range = document.createRange()
    range.selectNodeContents(span)
    selection.removeAllRanges()
    selection.addRange(range)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }

  selection?.removeAllRanges()
  span.remove()
  if (previous && selection) selection.addRange(previous)
  return ok
}

/**
 * Puts `text` on the clipboard and reports whether it landed.
 *
 * Synchronous on purpose: call it straight from the click/keydown handler. If you await
 * anything first, iOS Safari drops the user gesture and this silently returns false.
 */
export function copyText(text) {
  if (typeof text !== 'string' || text === '') return false

  if (capabilities.secure && navigator.clipboard?.writeText) {
    // Secure context (localhost, or netclip behind an HTTPS proxy). Fall back on rejection —
    // still inside the gesture on every browser that gets here.
    try {
      navigator.clipboard.writeText(text).catch(() => execCopy(text))
      return true
    } catch {
      /* fall through */
    }
  }
  return execCopy(text)
}

/** Copies actual image bytes. Only possible in a secure context; check capabilities first. */
export function copyImage(url) {
  if (!capabilities.copyImage) return Promise.reject(new Error('unavailable'))
  // Safari only accepts image/png, and only keeps the gesture alive when the ClipboardItem
  // is built synchronously around a *promise* — so the fetch happens inside it, not before.
  const png = fetch(url)
    .then((r) => r.blob())
    .then((blob) => (blob.type === 'image/png' ? blob : toPng(blob)))
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

function toPng(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      canvas.getContext('2d').drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('encode failed'))), 'image/png')
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('decode failed'))
    }
    img.src = url
  })
}

/* ------------------------------------------------------------------- ingest */

const imageRank = (type) => (type === 'image/png' ? 0 : type?.startsWith('image/') ? 1 : 2)

function collectFiles(dt) {
  const files = []
  if (dt?.items?.length) {
    for (const item of dt.items) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  if (!files.length && dt?.files?.length) files.push(...dt.files)
  return files
}

/**
 * Pulls content out of a paste event.
 *
 * Firefox can report a single pasted image as several clipboardData entries (image/png
 * plus image/jpeg plus a spare "Files" entry), so one paste is collapsed to one image,
 * preferring PNG. Text is only used when there is no image at all — pasting a screenshot
 * from a design tool often carries a junk text/plain alongside it.
 */
export function readPaste(event) {
  const dt = event.clipboardData
  // Collected once: getAsFile() allocates a new File on every call, and the item list is
  // only valid for the duration of this event.
  const files = collectFiles(dt)
  const images = files
    .filter((f) => f.type.startsWith('image/'))
    .sort((a, b) => imageRank(a.type) - imageRank(b.type))

  if (images.length) return { files: [images[0]], text: '' }
  if (files.length) return { files, text: '' }
  return { files: [], text: dt?.getData?.('text/plain') || '' }
}

/** Drag & drop, where multiple files genuinely means multiple files. */
export function readDrop(event) {
  const dt = event.dataTransfer
  const files = collectFiles(dt)
  if (files.length) return { files, text: '' }
  return { files: [], text: dt?.getData?.('text/plain') || '' }
}
