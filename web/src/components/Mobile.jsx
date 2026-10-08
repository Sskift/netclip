import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { dayGroup, formatBytes, relativeTime } from '../lib/time.js'
import { dimensions, highlight, prettyUrl, safeUrl, titleOf } from '../lib/format.js'
import { capabilities } from '../lib/clipboard.js'
import * as Icon from './Icons.jsx'

const FRESH_WINDOW_MS = 10 * 60 * 1000
const SWIPE_THRESHOLD = 0.25 // of card width
const TAP_SLOP = 8
const TAP_MS = 500

/** The one honest sentence about images this platform can act on. */
function imageHint() {
  if (capabilities.copyImage) return null
  if (capabilities.wechat) return { text: t('hint.wechat'), warn: true }
  if (capabilities.ios) return { text: t('hint.longPressIOS') }
  if (capabilities.android) return { text: t('hint.longPressAndroid') }
  return { text: t('hint.longPressDesktop') }
}

const saveLabel = () => (capabilities.ios ? t('action.saveToFiles') : t('action.download'))

/* ------------------------------------------------------------------- card */

function Card({ item, fresh, highlight: isHighlighted, query, now, nc, ui }) {
  const [flash, setFlash] = useState(false)
  const [copyState, setCopyState] = useState('idle')
  const [expanded, setExpanded] = useState(false)
  const [offset, setOffset] = useState(0)

  const touch = useRef(null)
  // The click event is dispatched AFTER touchend, so the verdict on "was that a tap or a
  // swipe" has to outlive the gesture — clearing touch.current in touchend and then
  // reading it from the click handler would mean the guard never blocks anything.
  const lastGesture = useRef(null)
  const cardRef = useRef(null)

  const url = item.kind === 'text' && item.flavor === 'url' ? safeUrl(nc.textOf(item) || item.preview) : null
  const hint = item.kind === 'image' ? imageHint() : null

  // Arrived here by scanning this item's QR code: put it on screen without being asked.
  useEffect(() => {
    if (!isHighlighted) return
    const id = setTimeout(() => cardRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 120)
    return () => clearTimeout(id)
  }, [isHighlighted])

  const confirmCopy = useCallback(() => {
    setFlash(true)
    setTimeout(() => setFlash(false), 1200)
    navigator.vibrate?.(10)
  }, [])

  /** Must stay synchronous — see lib/clipboard.js. */
  const doCopy = useCallback(() => {
    const result = nc.copy(item)
    if (result === 'ok') {
      setCopyState('idle') // otherwise the button stays stuck reading "Tap to copy"
      return confirmCopy()
    }
    if (result === 'manual') {
      setCopyState('idle')
      return ui.openManual(nc.textOf(item))
    }
    // 'pending' — the body isn't in memory, so this tap fetches and the next one copies.
    setCopyState('fetching')
    nc.fetchContent(item)
      .then(() => setCopyState('ready'))
      .catch(() => setCopyState('idle'))
  }, [item, nc, ui, confirmCopy])

  const primary = useCallback(() => {
    if (url) return window.open(url.href, '_blank', 'noopener')
    if (item.kind === 'text') return doCopy()
  }, [url, item, doCopy])

  /* --- gestures: swipe right = pin, swipe left = delete, with a tap guard --- */

  const onTouchStart = (e) => {
    lastGesture.current = null
    const point = e.touches[0]
    touch.current = { x: point.clientX, y: point.clientY, at: Date.now(), moved: false, dx: 0 }
  }

  const onTouchMove = (e) => {
    const start = touch.current
    if (!start) return
    const point = e.touches[0]
    const dx = point.clientX - start.x
    const dy = point.clientY - start.y
    if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) start.moved = true
    // Only take over horizontally; vertical belongs to the scroller.
    if (Math.abs(dx) > Math.abs(dy) * 1.4) {
      // The ref is the source of truth: the state exists only to drive the transform, and
      // reading it back in onTouchEnd would give whatever the last committed render saw.
      start.dx = dx
      setOffset(dx)
    }
  }

  const onTouchEnd = () => {
    const start = touch.current
    const width = cardRef.current?.offsetWidth || 320
    setOffset(0)
    touch.current = null
    if (!start) return

    const swiped = Math.abs(start.dx) > width * SWIPE_THRESHOLD
    lastGesture.current = { moved: start.moved, swiped, duration: Date.now() - start.at }

    if (swiped) {
      if (start.dx > 0) nc.togglePin(item)
      else nc.remove(item)
    }
  }

  // A flick-scroll or a swipe must never write to the clipboard: on http there is no way
  // to read the previous value back, so an accidental copy is unrecoverable.
  const tapped = (run) => (e) => {
    const gesture = lastGesture.current
    lastGesture.current = null // one verdict per gesture
    if (gesture && (gesture.moved || gesture.swiped || gesture.duration > TAP_MS)) return
    e.stopPropagation()
    run()
  }

  const meta = (
    <div className="nc-card-meta nc-chrome">
      {item.kind === 'image' ? <Icon.Image /> : item.kind === 'file' ? <Icon.File /> : url ? <Icon.Link /> : <Icon.Text />}
      <span className={flash ? 'nc-card-meta--copied' : undefined}>
        {flash ? t('action.copied') : relativeTime(item.updatedAt, now)}
      </span>
      {!flash && item.source && <span>· {item.source}</span>}
      {item.pinned && <Icon.Pin filled style={{ color: 'var(--nc-pin)', width: 13, height: 13 }} />}
      <span className="nc-spacer" />
      <button className="nc-card-more" onClick={tapped(() => ui.openCardActions(item, { expanded, setExpanded }))} aria-label={t('action.more')}>
        <Icon.More />
      </button>
    </div>
  )

  return (
    <article
      ref={cardRef}
      className={`nc-card${fresh || isHighlighted ? ' nc-card--fresh' : ''}`}
      data-pinned={item.pinned}
      data-flash={flash}
      style={offset ? { transform: `translateX(${offset * 0.4}px)` } : undefined}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {meta}

      {item.kind === 'image' ? (
        <>
          {/* nc-content, no anchor wrapper, no overlay: the OS long-press menu on this
              exact <img> is the only way an image reaches a phone's clipboard on http. */}
          <figure className="nc-card-figure nc-content">
            <img
              src={api.rawUrl(item)}
              alt={item.filename || t('kind.image')}
              loading="lazy"
              decoding="async"
              style={{
                aspectRatio: item.width && item.height ? `${item.width}/${item.height}` : undefined,
                background: item.color || 'var(--nc-bg-overlay)',
              }}
            />
          </figure>
          <div className="nc-card-dims">
            {[dimensions(item), formatBytes(item.bytes)].filter(Boolean).join(' · ')}
          </div>
          {hint && (
            <p className={`nc-hint${hint.warn ? ' nc-hint--warn' : ''}`}>
              <span aria-hidden>✋</span>
              {hint.text}
            </p>
          )}
        </>
      ) : (
        <div
          className={`nc-card-body${item.flavor === 'json' ? ' nc-card-body--mono' : ''}${
            expanded ? ' nc-card-body--expanded' : ''
          }`}
          dir="auto"
          onClick={tapped(primary)}
        >
          {highlight(url ? prettyUrl(url.href) : expanded ? nc.textOf(item) || item.preview : titleOf(item), query).map(
            (part, i) => (part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>),
          )}
        </div>
      )}

      {item.kind === 'file' && <div className="nc-card-dims">{formatBytes(item.bytes)}</div>}

      <div className="nc-card-actions nc-chrome">
        {url && (
          <button className="nc-btn nc-btn--primary" onClick={tapped(() => window.open(url.href, '_blank', 'noopener'))}>
            <Icon.External />
            {t('action.open')}
          </button>
        )}
        {item.kind === 'text' && (
          <button
            className={`nc-btn ${url ? 'nc-btn--ghost' : 'nc-btn--primary'}`}
            onClick={tapped(doCopy)}
            disabled={copyState === 'fetching'}
          >
            {copyState === 'fetching' ? <span className="nc-spinner" /> : <Icon.Copy />}
            {copyState === 'fetching'
              ? t('action.loading')
              : copyState === 'ready'
                ? t('action.tapToCopy')
                : t('action.copy')}
          </button>
        )}
        {item.kind !== 'text' && (
          <>
            {item.kind === 'image' && capabilities.copyImage && (
              <button
                className="nc-btn nc-btn--primary"
                onClick={tapped(() => ui.copyImage(item).then(confirmCopy, () => {}))}
              >
                <Icon.Copy />
                {t('action.copyImage')}
              </button>
            )}
            <a
              className="nc-btn nc-btn--ghost"
              href={api.rawUrl(item, { download: true })}
              download={item.filename || ''}
            >
              <Icon.Download />
              {saveLabel()}
            </a>
          </>
        )}
      </div>
    </article>
  )
}

/* ------------------------------------------------------------------ shell */

export default function Mobile({ nc, ui }) {
  const feedRef = useRef(null)
  const composing = useRef(false)
  const searchRef = useRef(null)
  const [searching, setSearching] = useState(false)
  const [atTop, setAtTop] = useState(true)
  const [seenTopId, setSeenTopId] = useState(null)
  const [now, setNow] = useState(() => Date.now())

  const { items, query } = nc

  useEffect(() => {
    const tick = () => setNow(Date.now())
    const timer = setInterval(tick, 60_000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [])

  useEffect(() => {
    if (atTop) setSeenTopId(items[0]?.id ?? null)
  }, [atTop, items])

  const newCount = useMemo(() => {
    if (atTop || seenTopId == null) return 0
    const index = items.findIndex((i) => i.id === seenTopId)
    return index > 0 ? index : 0
  }, [items, seenTopId, atTop])

  const pinned = useMemo(() => items.filter((i) => i.pinned && i.kind === 'text'), [items])
  const [chipFlash, setChipFlash] = useState(null)

  const freshId = useMemo(() => {
    if (searching || nc.filter !== 'all' || !atTop) return null
    const first = items[0]
    if (!first) return null
    if (now - first.updatedAt > FRESH_WINDOW_MS) return null
    // Never shout at the device that sent it.
    if (nc.sentByMe.has(first.id)) return null
    return first.id
  }, [items, searching, nc.filter, nc.sentByMe, atTop, now])

  const grouped = useMemo(() => {
    const out = []
    let current = null
    for (const item of items) {
      const key = item.pinned ? 'pinned' : dayGroup(item.updatedAt, now)
      if (key !== current && !searching) {
        out.push({ header: key })
        current = key
      }
      out.push({ item })
    }
    return out
  }, [items, now, searching])

  const copyChip = (item) => {
    const result = nc.copy(item)
    if (result === 'ok') {
      setChipFlash(item.id)
      navigator.vibrate?.(10)
      setTimeout(() => setChipFlash(null), 1200)
    } else if (result === 'manual') {
      ui.openManual(nc.textOf(item))
    } else {
      nc.fetchContent(item).catch(() => {})
    }
  }

  const openSearch = () => {
    setSearching(true)
    setTimeout(() => searchRef.current?.focus(), 50)
  }

  const closeSearch = () => {
    setSearching(false)
    if (searchRef.current) searchRef.current.value = ''
    nc.setQuery('')
    nc.setFilter('all')
  }

  return (
    <div className="nc-mobile">
      <header className="nc-mheader nc-chrome">
        <div className="nc-brand">
          <img src="/icon.svg" alt="" />
          netclip
        </div>
        <a className="nc-header-btn nc-drive-link" href="/drive"><Icon.Cloud />{t('header.drive')}</a>
        <span className="nc-mheader-status">
          <span className={`nc-dot${nc.connection === 'live' ? '' : ' nc-dot--off'}`} />
          {nc.connection === 'live' ? t('mobile.live') : t('mobile.reconnecting')}
        </span>
      </header>

      <div
        className={`nc-feed${searching ? ' nc-feed--search' : ''}`}
        ref={feedRef}
        onScroll={(e) => setAtTop(e.currentTarget.scrollTop < 8)}
      >
        {!items.length ? (
          <div className="nc-mempty">
            <strong>{query ? t('search.emptyTitle') : t('empty.mobileTitle')}</strong>
            {query ? t('search.emptyHint', { q: query }) : t('empty.mobileHint')}
          </div>
        ) : (
          grouped.map((entry, i) => {
            if (entry.header) {
              return (
                <div className="nc-mgroup nc-chrome" key={`h-${entry.header}-${i}`}>
                  {t(`group.${entry.header}`)}
                </div>
              )
            }
            const card = (
              <Card
                key={entry.item.id}
                item={entry.item}
                fresh={entry.item.id === freshId}
                highlight={ui.highlightId === entry.item.id}
                query={query}
                now={now}
                nc={nc}
                ui={ui}
              />
            )
            // The pinned strip sits *below* the fresh card: above it would push the newest
            // arrival off screen, which is the one thing this screen exists to show.
            if (entry.item.id === freshId && pinned.length && !searching) {
              return (
                <div key={`fresh-${entry.item.id}`}>
                  {card}
                  <div className="nc-chips nc-chrome">
                    {pinned.map((p) => (
                      <button
                        key={p.id}
                        className="nc-chip"
                        data-flash={chipFlash === p.id}
                        onClick={() => copyChip(p)}
                      >
                        <Icon.Pin filled style={{ width: 13, height: 13, color: 'var(--nc-pin)' }} />
                        <span>{chipFlash === p.id ? t('action.copied') : titleOf(p)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )
            }
            return card
          })
        )}
      </div>

      {newCount > 0 && !searching && (
        <button
          className="nc-newpill nc-chrome"
          onClick={() => feedRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          ↑ {t('mobile.new', { n: newCount })}
        </button>
      )}

      {searching ? (
        <div className="nc-search nc-chrome">
          <div className="nc-filters">
            {['all', 'text', 'image', 'file', 'pinned'].map((f) => (
              <button
                key={f}
                className="nc-filter"
                data-on={nc.filter === f}
                onClick={() => nc.setFilter(f)}
              >
                {t(`filter.${f === 'image' ? 'images' : f}`)}
              </button>
            ))}
          </div>
          <div className="nc-searchfield">
            <Icon.Search />
            <input
              ref={searchRef}
              type="search"
              defaultValue={query}
              enterKeyHint="search"
              placeholder={t('omnibar.placeholderTouch')}
              autoComplete="off"
              autoCorrect="off"
              spellCheck="false"
              onCompositionStart={() => (composing.current = true)}
              onCompositionEnd={(e) => {
                composing.current = false
                nc.setQuery(e.currentTarget.value)
              }}
              onChange={(e) => {
                if (!composing.current) nc.setQuery(e.target.value)
              }}
            />
            <button onClick={closeSearch} aria-label={t('action.close')}>
              <Icon.Close />
            </button>
          </div>
        </div>
      ) : (
        <nav className="nc-bar nc-chrome">
          <button
            className="nc-bar-btn"
            data-on={nc.filter === 'pinned'}
            onClick={() => nc.setFilter(nc.filter === 'pinned' ? 'all' : 'pinned')}
            aria-label={t('filter.pinned')}
          >
            <Icon.Pin filled={nc.filter === 'pinned'} style={{ width: 20, height: 20 }} />
          </button>
          <button className="nc-bar-btn nc-bar-btn--add" onClick={ui.openAdd} aria-label={t('add.title')}>
            <Icon.Plus style={{ width: 22, height: 22 }} />
          </button>
          <button className="nc-bar-btn" onClick={openSearch} aria-label={t('omnibar.placeholderTouch')}>
            <Icon.Search style={{ width: 20, height: 20 }} />
          </button>
        </nav>
      )}
    </div>
  )
}
