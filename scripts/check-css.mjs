#!/usr/bin/env node
/**
 * The highest-value guardrail in this app.
 *
 * On a plain-http LAN origin there is no programmatic way to put an image on a phone's
 * clipboard — ClipboardItem and navigator.share are both secure-context only. The OS
 * long-press menu on a real <img> is the entire feature, and a single
 * `-webkit-touch-callout: none` or a `user-select: none` on a content ancestor deletes it
 * silently: no error, no console output, nothing to notice until someone reports that
 * "saving photos doesn't work".
 *
 * So: scan the built CSS. `-webkit-touch-callout: none` is banned outright.
 * `user-select: none` is allowed only on selectors that are entirely chrome.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CSS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'public', 'assets')

/** Selectors that may legitimately suppress selection — bars, buttons, labels. */
const CHROME_ALLOWLIST = [
  '.nc-chrome',
  '.nc-bar',
  '.nc-btn',
  '.nc-kbd',
  '.nc-chip',
  '.nc-header',
  '.nc-mheader',
  '.nc-footer',
  '.nc-section',
  '.nc-mgroup',
  '.nc-filter',
  '.nc-menu',
  '.nc-sheet-header',
  '.nc-modal-header',
]

const isChromeOnly = (selector) =>
  selector
    .split(',')
    .map((s) => s.trim())
    .every((s) => s && CHROME_ALLOWLIST.some((allowed) => s.includes(allowed)))

const RULE = /([^{}]+)\{([^{}]*)\}/g

async function main() {
  let files
  try {
    files = (await readdir(CSS_DIR)).filter((f) => f.endsWith('.css'))
  } catch {
    console.error(`check-css: no build output at ${CSS_DIR} — run \`npm run build\` first.`)
    process.exit(1)
  }
  if (!files.length) {
    console.error('check-css: no CSS in the build output.')
    process.exit(1)
  }

  const problems = []

  for (const file of files) {
    const css = await readFile(join(CSS_DIR, file), 'utf8')
    for (const [, selector, body] of css.matchAll(RULE)) {
      const rule = body.replace(/\s+/g, ' ')

      if (/(-webkit-)?touch-callout:\s*none/.test(rule)) {
        problems.push(`${file}: "${selector.trim()}" sets touch-callout:none — this deletes the iOS long-press image menu.`)
      }

      if (/(^|;|\s)(-webkit-)?user-select:\s*none/.test(rule) && !isChromeOnly(selector)) {
        problems.push(
          `${file}: "${selector.trim()}" sets user-select:none outside the chrome allowlist — ` +
            `if it can match an ancestor of a content <img>, image copy dies silently on iOS.`,
        )
      }
    }
  }

  if (problems.length) {
    console.error('\ncheck-css FAILED — the image CSS contract was violated:\n')
    for (const p of problems) console.error('  · ' + p)
    console.error('\nSee the contract at the top of web/src/styles.css.\n')
    process.exit(1)
  }

  console.log(`check-css OK — ${files.length} bundle(s), image long-press contract intact.`)
}

main()
