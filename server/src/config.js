import { resolve } from 'node:path'

const num = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const MiB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000

export const config = {
  port: num(process.env.PORT ?? process.env.NETCLIP_PORT, 3210),
  host: process.env.NETCLIP_BIND || process.env.NETCLIP_HOST || '0.0.0.0',

  // The Dockerfile sets NETCLIP_DATA_DIR=/data; outside a container, default somewhere
  // writable so `npm start` from a clone doesn't die with EACCES on /data.
  dataDir: resolve(process.env.NETCLIP_DATA_DIR || 'data'),

  /**
   * Unpinned items hold a lease. It is granted on create, renewed when you copy the same
   * thing again, and renewed when you copy an item out of history — so anything you
   * actually use never expires. Pinned items hold no lease at all.
   * Images get a shorter one by default because they are what fills a disk.
   */
  retention: {
    text: num(process.env.NETCLIP_RETENTION_DAYS, 7) * DAY,
    image: num(process.env.NETCLIP_IMAGE_RETENTION_DAYS, 3) * DAY,
    file: num(process.env.NETCLIP_FILE_RETENTION_DAYS, 7) * DAY,
  },

  /** Backstops so a long-lived box stays healthy. Pinned items are never evicted. */
  maxItems: num(process.env.NETCLIP_MAX_ITEMS, 500),
  maxTotalBytes: num(process.env.NETCLIP_MAX_TOTAL_MB, 2048) * MiB,

  /** Per-upload limits. */
  maxUploadBytes: num(process.env.NETCLIP_MAX_UPLOAD_MB, 25) * MiB,
  maxTextBytes: num(process.env.NETCLIP_MAX_TEXT_KB, 1024) * 1024,

  /** How much text a list row shows. */
  previewChars: 300,

  /**
   * Text items at or below this size ship their FULL content inside the list response.
   * This is not an optimisation — it is what makes copying work at all. Safari only honours
   * document.execCommand('copy') synchronously inside a user gesture, so if a tap had to
   * await a fetch before copying it would silently do nothing on iOS. Bigger items fall
   * back to an explicit two-step "fetch, then tap to copy".
   */
  inlineTextBytes: 32 * 1024,
  /** ...and the inlining is capped in total too, newest-first, so a list is never megabytes. */
  inlineBudgetBytes: 1024 * 1024,

  /** Nothing younger than this is ever evicted by a cap. */
  evictionFloorMs: 5 * 60 * 1000,
  sweepIntervalMs: num(process.env.NETCLIP_SWEEP_MINUTES, 5) * 60 * 1000,

  dev: process.env.NETCLIP_DEV === '1',
}

export const ttlFor = (kind) => config.retention[kind] ?? config.retention.text

export const paths = {
  db: resolve(config.dataDir, 'netclip.db'),
  blobs: resolve(config.dataDir, 'blobs'),
  thumbs: resolve(config.dataDir, 'thumbs'),
  tmp: resolve(config.dataDir, 'tmp'),
}
