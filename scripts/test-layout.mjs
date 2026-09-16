#!/usr/bin/env node
/**
 * Real layout checks in a real engine.
 *
 * The jsdom suite drives behaviour but computes no boxes, so it is blind to an entire
 * class of failure: a card collapsing to 4px, a tap target too small to hit, content
 * spilling sideways. Those only show up once something actually performs layout — which
 * is how a flex-shrink bug shipped and made every mobile card a hairline.
 *
 *   npm run test:serve                 # in another terminal
 *   node scripts/test-layout.mjs [baseUrl] [--shots dir]
 */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://127.0.0.1:3299'
const shotFlag = process.argv.indexOf('--shots')
const shotDir = shotFlag > -1 ? process.argv[shotFlag + 1] : null
if (shotDir) mkdirSync(shotDir, { recursive: true })

const CHROME =
  process.env.CHROME_PATH ||
  `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`

const failures = []
const passes = []
const check = (label, ok, detail = '') => {
  if (ok) passes.push(`  ok    ${label}`)
  else failures.push(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function seed() {
  const post = (text) =>
    fetch(BASE + '/api/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })

  const existing = await fetch(BASE + '/api/items').then((r) => r.json())
  if (existing.items.length && !process.argv.includes('--force')) {
    console.error(`\nREFUSING TO RUN: ${BASE} already has ${existing.items.length} item(s).`)
    console.error('This suite wipes the instance. Point it at a scratch server, or pass --force.\n')
    process.exit(2)
  }
  await fetch(BASE + '/api/items', { method: 'DELETE' })

  // Enough rows that the feed must scroll — which is exactly the condition under which
  // shrinkable flex children collapse.
  for (let i = 0; i < 14; i++) await post(`clipboard entry number ${i} — some text to give it height`)
  await post('https://example.com/a/rather/long/link/that/should/wrap/somewhere')
  await post('supercalifragilisticexpialidocious'.repeat(6)) // unbreakable token
}

const run = async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })

  /* ------------------------------------------------------------- mobile */

  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    // Dark is the default theme and what a phone will actually be in.
    colorScheme: 'dark',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  })
  const p = await phone.newPage()
  await p.goto(BASE + '/', { waitUntil: 'networkidle' })
  await sleep(600)

  check('mobile shell rendered', await p.locator('.nc-mobile').isVisible())

  const cards = p.locator('.nc-card')
  const cardCount = await cards.count()
  check('cards rendered', cardCount >= 14, `${cardCount}`)

  // THE regression: a flex child with overflow:hidden has an automatic minimum size of 0,
  // so in a height-constrained column it shrinks to nothing.
  const heights = await cards.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))
  const min = Math.min(...heights)
  check(
    'no card is collapsed (flex-shrink regression)',
    min > 60,
    `shortest card is ${min.toFixed(1)}px; expected a real card, got a hairline`,
  )
  check('cards have plausible heights', Math.max(...heights) < 700, `tallest ${Math.max(...heights)}px`)

  const feed = await p.locator('.nc-feed').evaluate((e) => ({
    scroll: e.scrollHeight,
    client: e.clientHeight,
  }))
  check(
    'the feed actually scrolls with 16 items',
    feed.scroll > feed.client + 50,
    `scrollHeight ${feed.scroll} vs clientHeight ${feed.client}`,
  )

  // Nothing may spill sideways on a 390px phone.
  const overflowX = await p.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  check('no horizontal overflow', overflowX <= 0, `${overflowX}px of sideways scroll`)

  const unbreakable = await p
    .locator('.nc-card-body')
    .last()
    .evaluate((e) => e.getBoundingClientRect().width)
  check('a long unbroken token stays inside the card', unbreakable <= 390, `${unbreakable}px wide`)

  // Every bar control must be a real 44px target.
  const barBoxes = await p.locator('.nc-bar button').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      return { w: r.width, h: r.height }
    }),
  )
  check('bottom bar has 3 controls', barBoxes.length === 3, `${barBoxes.length}`)
  check(
    'every bar control is at least 44px tall',
    barBoxes.every((b) => b.h >= 44),
    barBoxes.map((b) => `${b.w.toFixed(0)}x${b.h.toFixed(0)}`).join(' '),
  )

  const primary = p.locator('.nc-card').first().locator('.nc-btn').first()
  if (await primary.count()) {
    const box = await primary.boundingBox()
    check('the primary card button is at least 44px tall', box.height >= 44, `${box?.height}px`)
  }

  // Scrolled all the way down, the feed's bottom padding must clear the bar — otherwise
  // the last card's actions sit underneath it and cannot be tapped.
  await p.locator('.nc-feed').evaluate((e) => e.scrollTo({ top: e.scrollHeight }))
  await sleep(300)
  const barTop = (await p.locator('.nc-bar').boundingBox()).y
  const lastCardBottom = await cards.last().evaluate((e) => e.getBoundingClientRect().bottom)
  check(
    'scrolled to the bottom, the bar does not cover the last card',
    lastCardBottom <= barTop + 1,
    `card bottom ${lastCardBottom.toFixed(0)} vs bar top ${barTop.toFixed(0)}`,
  )
  await p.locator('.nc-feed').evaluate((e) => e.scrollTo({ top: 0 }))
  await sleep(200)

  if (shotDir) await p.screenshot({ path: join(shotDir, 'mobile.png'), fullPage: false })

  // Search mode
  await p.locator('.nc-bar button').last().click()
  await sleep(300)
  check('search field appears', await p.locator('.nc-searchfield input').isVisible())
  const fontSize = await p
    .locator('.nc-searchfield input')
    .evaluate((e) => parseFloat(getComputedStyle(e).fontSize))
  // Anything under 16px makes iOS zoom the whole page when the field is focused.
  check('search input is >= 16px (or iOS zooms the page)', fontSize >= 16, `${fontSize}px`)
  if (shotDir) await p.screenshot({ path: join(shotDir, 'mobile-search.png') })
  await phone.close()

  /* ------------------------------------------------------------ desktop */

  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const d = await desk.newPage()
  await d.goto(BASE + '/', { waitUntil: 'networkidle' })
  await sleep(600)

  check('desktop shell rendered', await d.locator('.nc-desktop').isVisible())
  const rowHeights = await d.locator('.nc-row').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))
  check('rows are the intended 52px', rowHeights.every((h) => Math.abs(h - 52) < 1.5), `got ${rowHeights[0]}`)
  check('no row is collapsed', Math.min(...rowHeights) > 40, `shortest ${Math.min(...rowHeights)}`)

  const listBox = await d.locator('.nc-list').boundingBox()
  check('list pane is the intended 380px', Math.abs(listBox.width - 380) < 2, `${listBox.width}px`)

  const previewBox = await d.locator('.nc-preview').boundingBox()
  check('preview pane fills the rest', previewBox.width > 900, `${previewBox.width}px`)

  const footerBox = await d.locator('.nc-footer').boundingBox()
  check('footer is on screen', footerBox.y + footerBox.height <= 901, `bottom at ${footerBox.y + footerBox.height}`)

  const deskOverflow = await d.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  check('no horizontal overflow on desktop', deskOverflow <= 0, `${deskOverflow}px`)

  if (shotDir) await d.screenshot({ path: join(shotDir, 'desktop.png') })

  // The preview pane must render the selected item's body, not stay blank.
  await d.locator('.nc-row').nth(1).click()
  await sleep(400)
  const previewText = (await d.locator('.nc-preview-body').innerText()).trim()
  check('preview shows the selected item', previewText.length > 10, `"${previewText.slice(0, 30)}"`)

  await desk.close()
  await browser.close()
}

await seed()
await run()

for (const line of passes) console.log(line)
if (failures.length) {
  console.log('')
  for (const line of failures) console.log(line)
  console.log(`\n${failures.length} failure(s), ${passes.length} passed.\n`)
  process.exit(1)
}
console.log(`\nall ${passes.length} layout checks passed.${shotDir ? ` screenshots in ${shotDir}` : ''}\n`)
