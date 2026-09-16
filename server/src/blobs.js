import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { paths } from './config.js'

// One request at a time, no decoded-image cache: a clipboard app is bursty and idle, and
// libvips' defaults are tuned for a batch processor, not a box that also serves the UI.
sharp.cache(false)
sharp.concurrency(1)

const DECODE = { limitInputPixels: 100e6, sequentialRead: true, failOn: 'none' }
const MAX_EDGE = 12000
const MAX_PIXELS = 60e6
const THUMB_EDGE = 320

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const shard = (root, hash, ext = '') => join(root, hash.slice(0, 2), hash + ext)
export const blobPath = (hash) => shard(paths.blobs, hash)
export const thumbPath = (hash) => shard(paths.thumbs, hash, '.webp')

/**
 * Writes through a temp file on the same filesystem, so a crash mid-write can never leave
 * a truncated blob at the path a row already points at.
 */
async function writeAtomic(target, buf) {
  const dir = dirname(target)
  await mkdir(dir, { recursive: true })
  const tmp = join(paths.tmp, `${randomUUID()}.part`)
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(buf)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmp, target)
  // Make the rename itself durable; harmless if the platform doesn't support it.
  try {
    const dh = await open(dir, 'r')
    await dh.sync().catch(() => {})
    await dh.close()
  } catch {
    /* not fatal */
  }
}

export const putBlob = (hash, buf) => writeAtomic(blobPath(hash), buf)

export async function dropBlob(hash) {
  await Promise.allSettled([rm(blobPath(hash), { force: true }), rm(thumbPath(hash), { force: true })])
}

export const blobExists = (hash) => stat(blobPath(hash)).then(() => true, () => false)

/**
 * Decodes just enough of an image to render it well: true dimensions (EXIF-corrected), an
 * average colour to hold the layout while it loads, and a small thumbnail so a phone
 * scrolling the list never pulls down full-size screenshots.
 *
 * Anything sharp can't read (HEIC without libheif, corrupt files) degrades to a plain
 * attachment rather than failing the upload.
 */
export async function analyseImage(hash, buf) {
  const out = { width: null, height: null, color: null, has_thumb: 0 }

  let meta
  try {
    meta = await sharp(buf, DECODE).metadata()
  } catch {
    return out
  }

  // Orientations 5-8 mean the stored pixels are rotated a quarter turn. Browsers correct
  // for this when rendering, so the dimensions we report must match what is displayed —
  // otherwise the CSS aspect-ratio placeholder jumps the moment the image loads.
  const swapped = meta.orientation >= 5 && meta.orientation <= 8
  const width = (swapped ? meta.height : meta.width) ?? null
  const height = (swapped ? meta.width : meta.height) ?? null
  out.width = width
  out.height = height

  // A decode bomb is cheap to make and expensive to resize. Keep the original, skip the work.
  if (!width || !height || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
    return out
  }

  try {
    // .rotate() with no argument bakes in the EXIF orientation and drops the rest of the
    // metadata — so no GPS coordinates survive into a thumbnail we serve to the LAN.
    const pipeline = () => sharp(buf, DECODE).rotate()
    const [thumb, avg] = await Promise.all([
      pipeline()
        .resize(THUMB_EDGE, THUMB_EDGE, {
          fit: 'cover',
          // A tall screenshot is identified by its top, not its middle.
          position: height / width > 1.6 ? 'top' : 'centre',
          withoutEnlargement: true,
        })
        .webp({ quality: 70, effort: 4 })
        .toBuffer(),
      pipeline().resize(1, 1, { fit: 'fill' }).removeAlpha().raw().toBuffer(),
    ])
    await writeAtomic(thumbPath(hash), thumb)
    out.has_thumb = 1
    out.color = '#' + [...avg.subarray(0, 3)].map((c) => c.toString(16).padStart(2, '0')).join('')
  } catch {
    // Keep the original; it just won't have a thumbnail.
  }
  return out
}

/**
 * Deletes blobs that no row points at any more — the residue of a crash between the DB
 * commit and the unlink. The age grace is what makes this safe to run while an upload is
 * still in flight.
 */
export async function sweepOrphans(liveHashes, { graceMs = 60 * 60 * 1000 } = {}) {
  const cutoff = Date.now() - graceMs
  let removed = 0

  for (const root of [paths.blobs, paths.thumbs]) {
    let buckets = []
    try {
      buckets = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue
      const dir = join(root, bucket.name)
      let files = []
      try {
        files = await readdir(dir)
      } catch {
        continue
      }
      for (const file of files) {
        const hash = file.replace(/\.webp$/, '')
        if (liveHashes.has(hash)) continue
        const full = join(dir, file)
        try {
          const info = await stat(full)
          if (info.mtimeMs > cutoff) continue
          await rm(full, { force: true })
          removed++
        } catch {
          /* raced with something else; fine */
        }
      }
    }
  }
  return removed
}

/** Clears half-written uploads left behind by a crash. */
export async function clearTmp() {
  try {
    await rm(paths.tmp, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  await mkdir(paths.tmp, { recursive: true })
}
