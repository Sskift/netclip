import { config } from './config.js'
import * as store from './db.js'
import { clearTmp, dropBlob, sweepOrphans } from './blobs.js'
import { broadcast } from './events.js'

/**
 * Expiry the user never has to think about.
 *
 * Unpinned items hold a lease that is renewed every time you copy them or copy the same
 * thing again; when the lease runs out the item quietly goes away. Pins hold no lease.
 * Two backstops keep a long-lived box healthy — a count cap and a byte cap — both of which
 * take the *oldest unpinned* item first, never the largest. Deleting the screenshot you
 * just sent because it happens to be the biggest is astonishing behaviour.
 */
export async function sweep() {
  const now = Date.now()
  const removed = []

  const collect = async (rows) => {
    for (const row of rows) {
      store.deleteItem(row.id)
      if (row.kind === 'image') await dropBlob(row.hash)
      removed.push(row.id)
    }
  }

  await collect(store.listExpired(now))

  // Nothing that arrived in the last few minutes is ever evicted by a cap — otherwise a
  // single big paste could quietly delete the history to make room for itself.
  const floor = now - config.evictionFloorMs

  const overCount = store.countUnpinned() - config.maxItems
  if (overCount > 0) await collect(store.listEvictable(floor).slice(0, overCount))

  if (store.totalBytes() > config.maxTotalBytes) {
    // Only images free meaningful disk; evicting text rows would spin this loop and delete
    // the entire history for nothing.
    let total = store.totalBytes()
    const doomed = []
    for (const row of store.listEvictableImages(floor)) {
      if (total <= config.maxTotalBytes) break
      doomed.push(row)
      total -= row.bytes
    }
    await collect(doomed)
  }

  if (removed.length) broadcast('purged', { ids: removed })
  return removed.length
}

const log = (err) => console.error('[netclip] sweep failed:', err)

export async function startup() {
  await clearTmp()
  await sweep()
  const orphans = await sweepOrphans(store.allHashes())
  if (orphans) console.log(`[netclip] reclaimed ${orphans} orphaned blob(s)`)
}

export function startSweeper() {
  const timer = setInterval(() => {
    sweep()
      .then(() => {
        // Orphans are rare; a daily-ish pass on the same timer is plenty.
        if (Math.floor(Date.now() / 86_400_000) !== lastOrphanDay) {
          lastOrphanDay = Math.floor(Date.now() / 86_400_000)
          return sweepOrphans(store.allHashes())
        }
      })
      .catch(log)
  }, config.sweepIntervalMs)
  timer.unref()
  return () => clearInterval(timer)
}

let lastOrphanDay = Math.floor(Date.now() / 86_400_000)
