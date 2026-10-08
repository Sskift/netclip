import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api.js'
import { copyText } from './clipboard.js'

/** pinned first, then most recently copied. Matches the server's ORDER BY exactly. */
const order = (a, b) =>
  Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || b.id - a.id

const matches = (item, q) => {
  if (!q) return true
  const needle = q.toLowerCase()
  return (
    (item.content || '').toLowerCase().includes(needle) ||
    (item.preview || '').toLowerCase().includes(needle) ||
    (item.filename || '').toLowerCase().includes(needle)
  )
}

const upsert = (list, item, q) => {
  const without = list.filter((i) => i.id !== item.id)
  if (!matches(item, q)) return without
  return [...without, item].sort(order)
}

const UNDO_MS = 6000

export function useNetclip(active = true) {
  const [items, setItems] = useState([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [connection, setConnection] = useState('connecting')
  const [info, setInfo] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [flashMessage, setFlashMessage] = useState(null)
  const [undoTarget, setUndoTarget] = useState(null)
  // Keep only the latest pasted image locally: show it while uploading and reuse the
  // same bytes for its preview instead of downloading the original straight back.
  const [localImage, setLocalImage] = useState(null)
  const [localImageSource, setLocalImageSource] = useState(null)
  const localFile = localImage?.file
  useEffect(() => {
    if (!localFile) { setLocalImageSource(null); return }
    const url = URL.createObjectURL(localFile)
    setLocalImageSource({ file: localFile, url })
    return () => URL.revokeObjectURL(url)
  }, [localFile])
  const localImageUrl = localImageSource?.file === localFile ? localImageSource?.url : null
  const imageUrl = (item) => item?.id === localImage?.id && localImageUrl
    ? localImageUrl : api.rawUrl(item)

  const queryRef = useRef(query)
  queryRef.current = query
  const inflight = useRef(null)
  const refreshTimer = useRef(null)
  // Full text for items too big to inline in the list response, so copy stays synchronous.
  // A ref, because copy must read it without awaiting — but a ref write is invisible to
  // React, so every asynchronous fill also bumps `contentVersion` to force the re-render
  // that turns the preview's "Loading…" into the actual text.
  const contentCache = useRef(new Map())
  const [contentVersion, setContentVersion] = useState(0)
  const pendingFetches = useRef(new Set())

  const cacheContent = useCallback((id, content) => {
    if (content == null) return
    contentCache.current.set(id, content)
    setContentVersion((v) => v + 1)
  }, [])
  // Deletes are deferred client-side for the length of the undo window — no trash table,
  // and other devices see one clean removal instead of a delete followed by a re-insert.
  const pendingDeletes = useRef(new Map())
  // Ids removed while a list request was already in flight. Without this, the stale
  // response lands after the SSE frame and puts the deleted row back permanently.
  const gone = useRef(new Set())
  // Items this browser sent. Used so the phone that sent something doesn't then shout
  // about its own arrival.
  const sentByMe = useRef(new Set())

  const flash = useCallback((message, kind = 'info') => {
    setFlashMessage({ message, kind, at: Date.now() })
  }, [])

  useEffect(() => {
    if (!flashMessage) return
    const ms = flashMessage.kind === 'error' ? 5000 : 2000
    const timer = setTimeout(() => setFlashMessage(null), ms)
    return () => clearTimeout(timer)
  }, [flashMessage])

  /* ------------------------------------------------------------------ loading */

  const refresh = useCallback(
    async (q = queryRef.current) => {
      inflight.current?.abort()
      const controller = new AbortController()
      inflight.current = controller
      gone.current.clear()
      try {
        const next = await api.listItems(q, controller.signal)
        if (controller.signal.aborted) return
        for (const item of next) {
          if (item.content != null) contentCache.current.set(item.id, item.content)
        }
        // Drop anything that disappeared while this request was on the wire.
        setItems(next.filter((i) => !pendingDeletes.current.has(i.id) && !gone.current.has(i.id)))
        setLoading(false)
      } catch (err) {
        if (controller.signal.aborted || err.name === 'AbortError') return
        setLoading(false)
        if (err.status !== 0) flash(err.message, 'error')
      }
    },
    [flash],
  )

  const scheduleRefresh = useCallback(
    (delay = 400) => {
      clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => refresh(), delay)
    },
    [refresh],
  )

  // Debounced so an IME composing Chinese doesn't fire a request per keystroke.
  useEffect(() => {
    if (!active) return
    const timer = setTimeout(() => refresh(query), query ? 120 : 0)
    return () => clearTimeout(timer)
  }, [active, query, refresh])

  useEffect(() => {
    if (!active) return
    api.getInfo().then(setInfo).catch(() => {})
  }, [active])

  /* --------------------------------------------------------------- live feed */

  useEffect(() => {
    if (!active) return
    const disconnect = api.connectEvents({
      onStatus: (status) => {
        setConnection(status === 'reconnecting' ? 'reconnecting' : 'live')
        // Any reconnection after the first means we may have missed events.
        if (status === 'resynced') refresh()
      },
      onEvent: (type, data) => {
        if (type === 'deleted') {
          gone.current.add(data.id)
          setItems((list) => list.filter((i) => i.id !== data.id))
          contentCache.current.delete(data.id)
          return
        }
        if (type === 'purged') {
          const ids = new Set(data.ids)
          for (const id of data.ids) {
            gone.current.add(id)
            contentCache.current.delete(id)
          }
          setItems((list) => list.filter((i) => !ids.has(i.id)))
          return
        }
        // Don't resurrect a row the user just deleted while its undo window is open.
        if (pendingDeletes.current.has(data.id)) return
        if (data.content != null) contentCache.current.set(data.id, data.content)
        setItems((list) => upsert(list, data, queryRef.current))
        scheduleRefresh()
      },
    })
    return () => {
      disconnect()
      clearTimeout(refreshTimer.current)
    }
  }, [active, refresh, scheduleRefresh])

  /* ------------------------------------------------------- filtering + select */

  const visible = useMemo(() => {
    if (filter === 'all') return items
    if (filter === 'pinned') return items.filter((i) => i.pinned)
    return items.filter((i) => i.kind === filter)
  }, [items, filter])

  // Keep a selection alive as the list changes underneath it.
  useEffect(() => {
    if (!visible.length) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (selectedId == null || !visible.some((i) => i.id === selectedId)) {
      setSelectedId(visible[0].id)
    }
  }, [visible, selectedId])

  const selected = useMemo(
    () => visible.find((i) => i.id === selectedId) || null,
    [visible, selectedId],
  )

  /* ------------------------------------------------------------------ content */

  // contentVersion is in the dependency list on purpose: filling the cache must change
  // these functions' identity so memoised consumers recompute.
  const hasFullText = useCallback(
    (item) => !!item && (contentCache.current.has(item.id) || item.content != null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contentVersion],
  )

  /** Full text if we have it. Never async — see lib/clipboard.js for why that matters. */
  const textOf = useCallback(
    (item) => (item ? (contentCache.current.get(item.id) ?? item.content ?? '') : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contentVersion],
  )

  const fetchContent = useCallback(
    async (item) => {
      if (!item || item.kind !== 'text') return
      if (contentCache.current.has(item.id) || pendingFetches.current.has(item.id)) return
      pendingFetches.current.add(item.id)
      try {
        const full = await api.getItem(item.id)
        cacheContent(full?.id, full?.content)
      } finally {
        pendingFetches.current.delete(item.id)
      }
    },
    [cacheContent],
  )

  // Pull down the full text of a big item as soon as it's highlighted, so that by the time
  // the user presses copy the string is already in memory and the copy can be synchronous.
  useEffect(() => {
    if (!selected || selected.kind !== 'text' || !selected.truncated) return
    fetchContent(selected).catch(() => {})
  }, [selected, fetchContent])

  /* --------------------------------------------------------------------- copy */

  /**
   * Synchronous by contract. Returns 'ok' when the text is on the clipboard, 'manual'
   * when the caller must show the select-it-yourself sheet, and 'pending' when the body
   * hasn't arrived yet and the caller should offer an explicit second tap.
   */
  const copy = useCallback(
    (item) => {
      if (!item || item.kind !== 'text') return 'manual'
      if (!hasFullText(item)) {
        fetchContent(item).catch(() => {})
        return 'pending'
      }
      const ok = copyText(textOf(item))
      if (ok) api.markCopied(item.id)
      return ok ? 'ok' : 'manual'
    },
    [hasFullText, fetchContent, textOf],
  )

  /* --------------------------------------------------------------- mutations */

  const merge = useCallback((item) => {
    if (item?.content != null) contentCache.current.set(item.id, item.content)
    setItems((list) => upsert(list, item, queryRef.current))
  }, [])

  const addText = useCallback(
    async (text) => {
      const res = await api.addText(text)
      sentByMe.current.add(res.item.id)
      merge(res.item)
      setSelectedId(res.item.id)
      return res
    },
    [merge],
  )

  const addFiles = useCallback(
    async (files) => {
      const results = []
      for (const file of files) {
        const preview = file.type.startsWith('image/') && file.type !== 'image/svg+xml' ? { file } : null
        if (preview) setLocalImage(preview)
        try {
          const res = await api.addFile(file)
          if (preview) setLocalImage((current) => current === preview ? { ...preview, id: res.item.id } : current)
          sentByMe.current.add(res.item.id)
          merge(res.item)
          results.push(res)
        } catch (err) {
          if (preview) setLocalImage((current) => current === preview ? null : current)
          throw err
        }
      }
      if (results.length) setSelectedId(results[results.length - 1].item.id)
      return results
    },
    [merge],
  )

  const togglePin = useCallback(
    async (item) => {
      const next = !item.pinned
      setItems((list) => upsert(list, { ...item, pinned: next }, queryRef.current))
      try {
        merge(await api.setPinned(item.id, next))
      } catch (err) {
        setItems((list) => upsert(list, item, queryRef.current))
        flash(err.message, 'error')
      }
    },
    [merge, flash],
  )

  const commitDelete = useCallback((id) => {
    const entry = pendingDeletes.current.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    pendingDeletes.current.delete(id)
    api.deleteItem(id).catch(() => {})
  }, [])

  const remove = useCallback(
    (item) => {
      const index = visible.findIndex((i) => i.id === item.id)
      const nextSelection = visible[index + 1]?.id ?? visible[index - 1]?.id ?? null
      setItems((list) => list.filter((i) => i.id !== item.id))
      setSelectedId(nextSelection)

      gone.current.add(item.id)
      const timer = setTimeout(() => commitDelete(item.id), UNDO_MS)
      pendingDeletes.current.set(item.id, { timer, item })
      setUndoTarget({ item, at: Date.now() })
    },
    [visible, commitDelete],
  )

  const undoDelete = useCallback(() => {
    const target = undoTarget?.item
    setUndoTarget(null)
    if (!target) return
    const entry = pendingDeletes.current.get(target.id)
    if (!entry) return
    clearTimeout(entry.timer)
    pendingDeletes.current.delete(target.id)
    gone.current.delete(target.id)
    setItems((list) => upsert(list, target, queryRef.current))
    setSelectedId(target.id)
  }, [undoTarget])

  useEffect(() => {
    if (!undoTarget) return
    const timer = setTimeout(() => setUndoTarget(null), UNDO_MS)
    return () => clearTimeout(timer)
  }, [undoTarget])

  // A deferred delete must not be lost just because the tab went away.
  useEffect(() => {
    const flush = () => {
      for (const [id, entry] of pendingDeletes.current) {
        clearTimeout(entry.timer)
        api.deleteItemBeacon(id)
      }
      pendingDeletes.current.clear()
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  const clearAll = useCallback(async () => {
    try {
      const res = await api.clearUnpinned()
      refresh()
      return res.removed
    } catch (err) {
      flash(err.message, 'error')
      return 0
    }
  }, [flash, refresh])

  return {
    items: visible,
    allItems: items,
    query,
    setQuery,
    filter,
    setFilter,
    loading,
    connection,
    info,
    flashMessage,
    flash,
    selected,
    selectedId,
    setSelectedId,
    textOf,
    hasFullText,
    fetchContent,
    copy,
    sentByMe: sentByMe.current,
    addText,
    addFiles,
    imageUrl,
    pendingImage: localImage && localImage.id == null ? { file: localFile, url: localImageUrl } : null,
    togglePin,
    remove,
    undoTarget,
    undoDelete,
    clearAll,
    refresh,
  }
}
