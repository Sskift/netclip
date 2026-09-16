#!/usr/bin/env node
/**
 * Mounts the real, built UI in jsdom against the real server and drives it: search,
 * keyboard navigation, copy, pin, delete + undo. It is not a substitute for trying it on
 * a phone, but it does catch the class of failure a `vite build` never will — a component
 * that throws on mount, an effect that loops, a handler that references something gone.
 *
 *   node scripts/smoke.mjs [baseUrl]
 */
import { JSDOM, VirtualConsole } from 'jsdom'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.argv[2] || 'http://127.0.0.1:3210'

const failures = []
const notes = []
const check = (label, ok, detail = '') => {
  if (ok) notes.push(`  ok    ${label}`)
  else failures.push(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function boot({ width, height, ua }) {
  const html = await (await fetch(BASE + '/')).text()
  const virtualConsole = new VirtualConsole()
  const consoleErrors = []
  // jsdom refuses to follow the <a download> click that the download action performs.
  // That is a jsdom limitation, not an app fault.
  const IGNORE = /navigation to another Document|Not implemented: window\.scroll/
  const record = (message) => {
    if (!IGNORE.test(message)) consoleErrors.push(message)
  }
  virtualConsole.on('jsdomError', (err) => record(String(err.message || err)))
  virtualConsole.on('error', (...args) => record(args.join(' ')))

  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  })

  const { window } = dom
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
  // jsdom 29 ignores the constructor's userAgent option, and the platform probes in
  // lib/clipboard.js read these directly.
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
  Object.defineProperty(window.navigator, 'platform', {
    value: /iPhone|iPad/.test(ua) ? 'iPhone' : 'MacIntel',
    configurable: true,
  })
  Object.defineProperty(window.navigator, 'maxTouchPoints', {
    value: /iPhone|iPad|Android/.test(ua) ? 5 : 0,
    configurable: true,
  })

  // ── the capability surface a real browser has and jsdom doesn't ──────────
  window.isSecureContext = false // exactly the LAN case we care about
  window.matchMedia = (query) => ({
    matches: /pointer: coarse/.test(query) ? width < 820 : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })
  window.Element.prototype.scrollIntoView = function () {}
  window.Element.prototype.scrollTo = function () {}
  window.HTMLElement.prototype.focus = window.HTMLElement.prototype.focus || function () {}
  window.URL.createObjectURL = () => 'blob:stub'
  window.URL.revokeObjectURL = () => {}
  window.navigator.vibrate = () => true
  window.fetch = (input, init) =>
    fetch(typeof input === 'string' && input.startsWith('/') ? BASE + input : input, init)
  window.AbortController = AbortController

  // A minimal EventSource so the live-update path is exercised rather than skipped.
  const sources = []
  window.EventSource = class {
    constructor(url) {
      this.url = url
      this.listeners = new Map()
      sources.push(this)
      setTimeout(() => this.emit('open', {}), 0)
    }
    addEventListener(type, fn) {
      this.listeners.set(type, [...(this.listeners.get(type) || []), fn])
    }
    removeEventListener() {}
    emit(type, event) {
      for (const fn of this.listeners.get(type) || []) fn(event)
    }
    close() {}
  }

  // execCommand('copy') is what the app really uses on http; record that it was called.
  const copies = []
  window.document.execCommand = (cmd) => {
    if (cmd === 'copy') {
      copies.push(window.getSelection()?.toString() ?? '')
      return true
    }
    return false
  }

  const bundle = /src="([^"]+\.js)"/.exec(html)?.[1]
  const code = await readFile(join(ROOT, 'server', 'public', bundle.replace(/^\//, '')), 'utf8')
  window.eval(code)

  return { dom, window, consoleErrors, copies, sources }
}

const q = (window, sel) => window.document.querySelector(sel)
const qa = (window, sel) => [...window.document.querySelectorAll(sel)]
const text = (window, sel) => q(window, sel)?.textContent?.trim() ?? ''

function press(window, key, opts = {}) {
  window.dispatchEvent(
    new window.KeyboardEvent('keydown', { key, code: opts.code || key, bubbles: true, ...opts }),
  )
}

function click(window, node) {
  node?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

/**
 * React tracks an input's last value and swallows an `input` event when the tracked value
 * still matches — so assigning `.value` directly is invisible to it. Going through the
 * prototype's native setter is what a real keystroke does.
 */
function type(window, input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

/* ------------------------------------------------------------------ seed */

async function seed() {
  const post = (body, headers) =>
    fetch(BASE + '/api/items', { method: 'POST', headers, body }).then((r) => r.json())

  // DELETE /api/items deliberately spares pinned rows, so unpin first — otherwise a pin
  // left behind by another suite shifts every row assertion below.
  const existing = await fetch(BASE + '/api/items').then((r) => r.json())

  // Same guard as test-server.mjs: this wipes the instance, and the default port is the
  // one a real deployment uses. Never let a stray run take out someone's clipboard.
  if (existing.items.length && !process.argv.includes('--force')) {
    console.error(`\nREFUSING TO RUN: ${BASE} already has ${existing.items.length} item(s).`)
    console.error('This suite deletes everything, including pins. Point it at a scratch server, or pass --force.\n')
    process.exit(2)
  }
  for (const item of existing.items.filter((i) => i.pinned)) {
    await fetch(`${BASE}/api/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: false }),
    })
  }
  await fetch(BASE + '/api/items', { method: 'DELETE' })
  await post(JSON.stringify({ text: 'https://example.com/netclip/pull/42' }), {
    'content-type': 'application/json',
  })
  await post(JSON.stringify({ text: 'docker run -d -p 3210:3210 netclip' }), {
    'content-type': 'application/json',
  })
  // Bigger than config.inlineTextBytes, so the list response marks it truncated and the
  // client has to fetch the body — the path that used to leave the preview on "Loading…".
  await post(JSON.stringify({ text: 'BIGTEXT ' + 'q'.repeat(40_000) }), {
    'content-type': 'application/json',
  })
  await post(JSON.stringify({ text: '你好世界 clipboard test' }), {
    'content-type': 'application/json',
  })

  const png = await readFile(join(ROOT, 'web', 'public', 'icon-180.png'))
  await fetch(BASE + '/api/items/file', {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-filename': 'shot.png' },
    body: png,
  })
}

/* --------------------------------------------------------------- desktop */

async function testDesktop() {
  console.log('\n── desktop (1440×900, plain http, no secure context) ──')
  const { window, consoleErrors, copies } = await boot({
    width: 1440,
    height: 900,
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Chrome/154 Safari/537',
  })
  await sleep(700)

  check('desktop shell rendered', !!q(window, '.nc-desktop'))
  check('omnibar present and focused-capable', !!q(window, '.nc-omnibar input'))
  const rows = qa(window, '.nc-row')
  check('rows rendered', rows.length === 5, `got ${rows.length}`)
  check('section headers rendered', qa(window, '.nc-section').length >= 1)
  check('preview pane rendered', !!q(window, '.nc-preview'))
  check('image row has a real <img> thumbnail', !!q(window, 'img.nc-row-thumb'))
  check('footer shows contextual shortcut hints', qa(window, '.nc-footer-hint').length >= 4)

  // The newest item is the image, so the footer must offer Download, not Copy.
  check(
    'image selection offers Download, not Copy',
    text(window, '.nc-footer-hints').includes('Download') &&
      !text(window, '.nc-footer-hints').includes('Copy'),
    text(window, '.nc-footer-hints'),
  )

  // first row is selected by default
  check('a row is selected on load', !!q(window, '.nc-row[data-selected="true"]'))

  // ── keyboard: ArrowDown moves the selection ──
  const before = qa(window, '.nc-row').findIndex((r) => r.dataset.selected === 'true')
  press(window, 'ArrowDown')
  await sleep(80)
  const after = qa(window, '.nc-row').findIndex((r) => r.dataset.selected === 'true')
  check('ArrowDown moves selection', after === before + 1, `${before} → ${after}`)
  check(
    'footer hints follow the selection kind',
    text(window, '.nc-footer-hints').includes('Copy'),
    text(window, '.nc-footer-hints'),
  )

  // ── Enter copies via execCommand, the only path that works on http ──
  const copiesBefore = copies.length
  press(window, 'Enter')
  await sleep(200)
  check('Enter copies through execCommand', copies.length > copiesBefore, `${copies.length} copies`)
  check('copied text is non-empty', (copies[copies.length - 1] || '').length > 0)

  // ── search, including CJK ──
  const input = q(window, '.nc-omnibar input')
  type(window, input, '你好')
  await sleep(500)
  check('CJK search narrows the list', qa(window, '.nc-row').length === 1, `${qa(window, '.nc-row').length} rows`)
  check('search term is highlighted', !!q(window, '.nc-row mark'))

  // zero results flips ↵ to "send"
  type(window, input, 'zzzz-no-such-thing')
  await sleep(500)
  check('zero-result empty state shown', !!q(window, '.nc-empty'))
  // The transient "Copied" flash from the step above owns the footer for 2s; the ↵ flip
  // announcement takes over once it clears.
  await sleep(2200)
  check(
    'footer announces the ↵ flip',
    text(window, '.nc-footer-left').includes('zzzz'),
    text(window, '.nc-footer-left'),
  )

  press(window, 'Escape')
  await sleep(400)
  check('Escape clears the query', qa(window, '.nc-row').length === 5, `${qa(window, '.nc-row').length} rows`)

  // ── a truncated item's body must arrive and re-render the preview ──
  // The cache is a ref (copy has to read it synchronously), so filling it has to force a
  // render explicitly. Without that the pane sits on "Loading…" until an unrelated timer.
  const bigRow = qa(window, '.nc-row').find((r) => r.textContent.includes('BIGTEXT'))
  check('the oversized item is in the list', !!bigRow)
  click(window, bigRow)
  await sleep(900)
  const previewText = text(window, '.nc-preview-text')
  check(
    'selecting a truncated item fetches and RENDERS its body',
    previewText.startsWith('BIGTEXT') && previewText.length > 1000,
    `preview is ${previewText.length} chars: "${previewText.slice(0, 40)}"`,
  )

  const copiesBeforeBig = copies.length
  press(window, 'Enter')
  await sleep(200)
  check('a truncated item copies in full once its body has arrived', copies.length > copiesBeforeBig)
  check(
    '...and the copied text is the whole body, not the preview',
    (copies[copies.length - 1] || '').length > 10_000,
    `${(copies[copies.length - 1] || '').length} chars`,
  )

  // ── pin ──
  press(window, 'p', { code: 'KeyP', altKey: true })
  await sleep(400)
  check('⌥P pins the selection', qa(window, '.nc-row[data-pinned="true"]').length === 1)
  check('a PINNED section header appeared', qa(window, '.nc-section').some((s) => s.textContent.trim().length > 0))
  press(window, 'p', { code: 'KeyP', altKey: true })
  await sleep(400)
  check('⌥P unpins again', qa(window, '.nc-row[data-pinned="true"]').length === 0)

  // ── action menu ──
  press(window, 'k', { code: 'KeyK', metaKey: true, ctrlKey: true })
  await sleep(150)
  check('⌘K opens the action menu', !!q(window, '.nc-menu'))
  check('menu has a delete entry', qa(window, '.nc-menu-item').some((b) => b.className.includes('danger')))
  press(window, 'Escape')
  await sleep(120)
  check('Escape closes the menu', !q(window, '.nc-menu'))

  // ── QR overlay ──
  press(window, 'g', { code: 'KeyG', metaKey: true, ctrlKey: true })
  await sleep(200)
  check('⌘G opens a QR overlay', !!q(window, '.nc-qr'))
  check('QR renders actual modules', (q(window, '.nc-qr path')?.getAttribute('d') || '').length > 100)
  press(window, 'Escape')
  await sleep(150)
  check('Escape closes the QR overlay', !q(window, '.nc-qr'))

  // ── delete + undo ──
  const countBefore = qa(window, '.nc-row').length
  press(window, 'Backspace', { code: 'Backspace', metaKey: true, ctrlKey: true })
  await sleep(200)
  check('⌘⌫ removes the row', qa(window, '.nc-row').length === countBefore - 1)
  check('undo snackbar appears', !!q(window, '.nc-snackbar'))
  click(window, q(window, '.nc-snackbar button'))
  await sleep(250)
  check('undo restores the row', qa(window, '.nc-row').length === countBefore)

  // ── paste anywhere sends ──
  const paste = new window.Event('paste', { bubbles: true, cancelable: true })
  paste.clipboardData = {
    items: [],
    files: [],
    getData: (type) => (type === 'text/plain' ? 'pasted from the smoke test' : ''),
  }
  window.document.dispatchEvent(paste)
  await sleep(700)
  check(
    'paste creates a new item',
    qa(window, '.nc-row-title').some((n) => n.textContent.includes('pasted from the smoke test')),
  )

  check('no uncaught errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  window.close()
}

/* ---------------------------------------------------------------- mobile */

async function testMobile() {
  console.log('\n── mobile (390×844, iPhone Safari UA, plain http) ──')
  const { window, consoleErrors, copies } = await boot({
    width: 390,
    height: 844,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
  })
  await sleep(700)

  check('mobile shell rendered', !!q(window, '.nc-mobile'))
  check('no desktop shell', !q(window, '.nc-desktop'))
  const cards = qa(window, '.nc-card')
  check('cards rendered', cards.length >= 4, `got ${cards.length}`)
  check('bottom bar rendered', !!q(window, '.nc-bar'))
  check('bottom bar has add button', !!q(window, '.nc-bar-btn--add'))

  // The image contract: a real <img>, not wrapped in an anchor, no overlay.
  const img = q(window, '.nc-card-figure img')
  check('image card uses a real <img>', !!img)
  check('image <img> is not wrapped in an anchor', !img?.closest('a'))
  check('image src is the full-resolution blob, not the thumbnail', /\/raw$/.test(img?.getAttribute('src') || ''))
  check('image hint line is shown', qa(window, '.nc-hint').length >= 1)
  check(
    'hint names the iOS gesture',
    qa(window, '.nc-hint').some((n) => /Add to Photos|存储到/.test(n.textContent)),
  )

  // Tap a text card body → copies
  const copiesBefore = copies.length
  const body = q(window, '.nc-card-body')
  click(window, body)
  await sleep(200)
  check('tapping a card body copies', copies.length > copiesBefore)

  // Search morphs the bar in place
  const searchBtn = qa(window, '.nc-bar-btn').at(-1)
  click(window, searchBtn)
  await sleep(150)
  check('search morphs the bar', !!q(window, '.nc-searchfield'))
  check('filter chips appear', qa(window, '.nc-filter').length === 4)
  const searchInput = q(window, '.nc-searchfield input')
  type(window, searchInput, 'docker')
  await sleep(500)
  check('search narrows the feed', qa(window, '.nc-card').length === 1, `${qa(window, '.nc-card').length} cards`)

  // Filter chips. Clear the query first — with 'docker' still active the feed is empty and
  // "every card is an image card" would pass vacuously.
  type(window, searchInput, '')
  await sleep(400)
  click(window, qa(window, '.nc-filter')[2]) // Images
  await sleep(400)
  const filtered = qa(window, '.nc-card')
  check('image filter leaves some cards', filtered.length > 0, `${filtered.length} cards`)
  check('image filter excludes text cards', qa(window, '.nc-card-figure').length === filtered.length)

  // ── the ⋯ sheet must be able to open another overlay ──
  // Closing the sheet and opening the next overlay land in one React batch, so the order
  // of those two writes decides whether "Show QR code" does anything at all.
  click(window, q(window, '.nc-card-more'))
  await sleep(200)
  check('the card action sheet opens', !!q(window, '.nc-sheet'))
  const qrAction = qa(window, '.nc-sheet-item').find((b) => /QR|二维码/.test(b.textContent))
  check('the sheet offers Show QR code', !!qrAction)
  click(window, qrAction)
  await sleep(300)
  check('choosing Show QR code actually opens the QR overlay', !!q(window, '.nc-qr'))
  check('...and the sheet is gone', !q(window, '.nc-sheet'))

  check('no uncaught errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  window.close()
}

/* ------------------------------------------------------------------ main */

try {
  await fetch(BASE + '/api/health')
} catch {
  console.error(`smoke: no server at ${BASE}. Start it first.`)
  process.exit(1)
}

await seed()
await testDesktop()
await testMobile()

console.log('')
for (const n of notes) console.log(n)
if (failures.length) {
  console.log('')
  for (const f of failures) console.log(f)
  console.log(`\n${failures.length} failure(s), ${notes.length} passed.\n`)
  process.exit(1)
}
console.log(`\nall ${notes.length} checks passed.\n`)
