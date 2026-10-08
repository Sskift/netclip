import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../lib/api.js'
import { t, MOD, ALT, BACKSPACE, isMac } from '../lib/i18n.js'
import { dayGroup, relativeTime } from '../lib/time.js'
import { ageOpacity, highlight, safeUrl, terminalSnippet, titleOf } from '../lib/format.js'
import { phoneUrl } from '../lib/qr.js'
import Preview from './Preview.jsx'
import * as Icon from './Icons.jsx'

const combo = (label) => (isMac ? MOD + label : `${MOD}+${label}`)

/* ------------------------------------------------------------------- rows */

function RowIcon({ item }) {
  if (item.kind === 'file') return <span className="nc-row-icon"><Icon.File /></span>
  if (item.kind === 'image') {
    return (
      <img
        className="nc-row-thumb"
        src={api.thumbUrl(item)}
        alt=""
        loading="lazy"
        decoding="async"
        style={{ background: item.color || undefined }}
      />
    )
  }
  if (item.flavor === 'url') return <span className="nc-row-icon"><Icon.Link /></span>
  if (item.flavor === 'json') return <span className="nc-row-icon"><Icon.Braces /></span>
  if (item.flavor === 'color') {
    return <span className="nc-row-swatch" style={{ background: item.preview }} />
  }
  return <span className="nc-row-icon"><Icon.Text /></span>
}

function Row({ item, selected, query, now, onSelect, onActivate }) {
  const title = titleOf(item)
  return (
    <button
      className="nc-row"
      data-selected={selected}
      data-pinned={item.pinned}
      onMouseDown={(e) => e.preventDefault() /* keep the omnibar focused */}
      onClick={() => onSelect(item.id)}
      onDoubleClick={() => onActivate(item)}
      style={{ opacity: ageOpacity(item, now) }}
    >
      <RowIcon item={item} />
      <span className="nc-row-title" dir="auto">
        {highlight(title, query).map((part, i) =>
          part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
        )}
      </span>
      <span className="nc-row-time">{relativeTime(item.updatedAt, now)}</span>
    </button>
  )
}

/* ------------------------------------------------------------ action menu */

function ActionMenu({ actions, onClose }) {
  const [active, setActive] = useState(() => actions.findIndex((a) => !a.separator && !a.disabled))

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') return onClose()
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
      if (step) {
        e.preventDefault()
        setActive((current) => {
          let next = current
          for (let i = 0; i < actions.length; i++) {
            next = (next + step + actions.length) % actions.length
            if (!actions[next].separator && !actions[next].disabled) return next
          }
          return current
        })
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        actions[active]?.run?.()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [actions, active, onClose])

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 35 }} onMouseDown={onClose} />
      <div className="nc-menu nc-chrome" role="menu">
        {actions.map((action, i) =>
          action.separator ? (
            <div className="nc-menu-sep" key={action.key} />
          ) : (
            <button
              key={action.key}
              className={`nc-menu-item${action.danger ? ' nc-menu-item--danger' : ''}`}
              data-active={i === active}
              disabled={action.disabled}
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                action.run()
                onClose()
              }}
            >
              {action.icon}
              <span>{action.label}</span>
              <span className="nc-spacer" />
              {action.hint && <span className="nc-kbd">{action.hint}</span>}
            </button>
          ),
        )}
      </div>
    </>
  )
}

/* ---------------------------------------------------------------- footer */

function Footer({ nc, flash, willSend }) {
  const devices = nc.info?.connectedClients ?? 0
  const item = nc.selected

  const hints = []
  if (item?.kind === 'text') hints.push([t('action.copy'), '↵'])
  if (item?.flavor === 'url') hints.push([t('action.open'), combo('O')])
  if (item && item.kind !== 'text') hints.push([t('action.download'), combo('S')])
  hints.push([item?.pinned ? t('action.unpin') : t('action.pin'), `${ALT}P`])
  hints.push([t('action.showQr'), combo('G')])
  hints.push([t('action.delete'), isMac ? `${MOD}${BACKSPACE}` : `${MOD}+${BACKSPACE}`])
  hints.push([t('action.more'), combo('K')])

  let left
  if (flash) left = <span className={flash.kind === 'error' ? 'nc-footer--error' : ''}>{flash.message}</span>
  else if (willSend) left = <span className="nc-footer--alert">{willSend}</span>
  else if (nc.connection === 'reconnecting') left = <span>{t('mobile.reconnecting')}</span>
  else if (devices > 1) left = <><span className="nc-dot" />{t('footer.devices', { n: devices })}</>
  else if (devices === 1) left = <><span className="nc-dot" />{t('footer.device')}</>
  else left = <span className="nc-footer--alert"><span className="nc-dot nc-dot--off" /> {t('footer.noDevices')}</span>

  return (
    <div className="nc-footer nc-chrome">
      <div className="nc-footer-left">{left}</div>
      <div className="nc-footer-hints">
        {hints.map(([label, key]) => (
          <span className="nc-footer-hint" key={label + key}>
            {label} <span className="nc-kbd">{key}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------- shell */

export default function Desktop({ nc, ui }) {
  const inputRef = useRef(null)
  const rowRefs = useRef(new Map())
  const composing = useRef(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const { items, selected, query } = nc

  // Relative times and the aging ramp go stale if nothing ever re-renders.
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const timer = setInterval(tick, 60_000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [])

  const focusOmnibar = useCallback((selectAll) => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (selectAll) el.select()
  }, [])

  useEffect(() => {
    focusOmnibar()
  }, [focusOmnibar])

  // Keep the highlighted row on screen while arrow-keying.
  useEffect(() => {
    if (selected == null) return
    rowRefs.current.get(selected)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const grouped = useMemo(() => {
    const out = []
    let current = null
    for (const item of items) {
      const key = item.pinned ? 'pinned' : dayGroup(item.updatedAt, now)
      if (key !== current) {
        out.push({ header: key })
        current = key
      }
      out.push({ item })
    }
    return out
  }, [items, now])

  const move = useCallback(
    (step) => {
      if (!items.length) return
      const index = items.findIndex((i) => i.id === nc.selectedId)
      const next = (index + step + items.length) % items.length
      nc.setSelectedId(items[next].id)
    },
    [items, nc],
  )

  const sendQuery = useCallback(() => {
    const value = inputRef.current?.value?.trim()
    if (!value) return
    nc.addText(value)
      .then(() => {
        inputRef.current.value = ''
        nc.setQuery('')
        ui.flashFooter(t('footer.sent'))
      })
      .catch((err) => nc.flash(err.message, 'error'))
  }, [nc, ui])

  const copySelected = useCallback(() => {
    if (!selected) return
    if (selected.kind !== 'text') return ui.download(selected)
    const result = nc.copy(selected)
    if (result === 'ok') ui.flashFooter(t('action.copied'))
    else if (result === 'manual') ui.openManual(nc.textOf(selected))
    else ui.flashFooter(t('action.loading'))
  }, [selected, nc, ui])

  const actions = useMemo(() => {
    const item = selected
    const url = item?.flavor === 'url' ? safeUrl(nc.textOf(item) || item.preview) : null
    return [
      { key: 'copy', label: t('action.copy'), hint: '↵', icon: <Icon.Copy />, disabled: !item || item.kind !== 'text', run: copySelected },
      { key: 'open', label: t('action.openBrowser'), hint: combo('O'), icon: <Icon.External />, disabled: !url, run: () => url && window.open(url.href, '_blank', 'noopener') },
      { key: 'qr', label: t('action.showQr'), hint: combo('G'), icon: <Icon.Qr />, disabled: !item, run: () => item && ui.openQr(phoneUrl(nc.info, `/i/${item.id}`)) },
      { key: 'download', label: t('action.download'), hint: combo('S'), icon: <Icon.Download />, disabled: !item, run: () => item && ui.download(item) },
      { key: 'pin', label: item?.pinned ? t('action.unpin') : t('action.pin'), hint: `${ALT}P`, icon: <Icon.Pin filled={item?.pinned} />, disabled: !item, run: () => item && nc.togglePin(item) },
      { key: 'curl', label: t('action.curl'), icon: <Icon.Text />, run: ui.openCurl },
      { key: 'sep', separator: true },
      { key: 'delete', label: t('action.delete'), hint: isMac ? `${MOD}${BACKSPACE}` : `${MOD}+${BACKSPACE}`, icon: <Icon.Trash />, danger: true, disabled: !item, run: () => item && nc.remove(item) },
      { key: 'clear', label: t('action.deleteAll'), hint: isMac ? `⇧${MOD}${BACKSPACE}` : `Shift+${MOD}+${BACKSPACE}`, icon: <Icon.Trash />, danger: true, run: ui.confirmClearAll },
    ]
  }, [selected, nc, ui, copySelected])

  /* ------------------------------------------------------------ keyboard */

  useEffect(() => {
    if (ui.modalOpen || menuOpen) return

    const onKey = (e) => {
      if (e.isComposing || composing.current) return
      const mod = isMac ? e.metaKey : e.ctrlKey
      const inPreview = document.activeElement?.classList?.contains('nc-preview-text')

      if (e.key === 'ArrowDown' && !inPreview) return e.preventDefault(), move(1)
      if (e.key === 'ArrowUp' && !inPreview) return e.preventDefault(), move(-1)

      if (e.key === 'Enter') {
        e.preventDefault()
        // With a query that matched nothing, ↵ becomes "send what I typed" — announced
        // in the footer before you press it, so it is never a surprise.
        if (mod || (query.trim() && !items.length)) sendQuery()
        else copySelected()
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        if (inputRef.current?.value) {
          inputRef.current.value = ''
          nc.setQuery('')
        } else if (items.length) {
          nc.setSelectedId(items[0].id)
        }
        focusOmnibar()
        return
      }

      // ⌥P rather than ⌘P (print) or ⌃P — and preventDefault, because on macOS ⌥P
      // otherwise types π straight into the omnibar.
      if (e.altKey && e.code === 'KeyP') {
        e.preventDefault()
        if (selected) nc.togglePin(selected)
        return
      }

      if (!mod) return

      switch (e.code) {
        case 'KeyK':
          e.preventDefault()
          setMenuOpen(true)
          break
        case 'KeyG':
          e.preventDefault()
          if (selected) ui.openQr(phoneUrl(nc.info, `/i/${selected.id}`))
          break
        case 'KeyO': {
          const url = selected?.flavor === 'url' ? safeUrl(nc.textOf(selected) || selected.preview) : null
          if (!url) return
          e.preventDefault()
          window.open(url.href, '_blank', 'noopener')
          break
        }
        case 'KeyS':
          e.preventDefault()
          if (selected) ui.download(selected)
          break
        case 'KeyF':
          e.preventDefault()
          focusOmnibar(true)
          break
        case 'KeyZ':
          if (nc.undoTarget) {
            e.preventDefault()
            nc.undoDelete()
          }
          break
        case 'Backspace':
          e.preventDefault()
          if (e.shiftKey) ui.confirmClearAll()
          else if (selected) nc.remove(selected)
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ui, menuOpen, move, query, items, selected, nc, sendQuery, copySelected, focusOmnibar])

  /* --------------------------------------------------------------- render */

  const willSend = query.trim() && !items.length ? t('footer.willSend', { q: query.trim() }) : null
  const origin = phoneUrl(nc.info)

  return (
    <div className="nc-desktop">
      <header className="nc-header nc-chrome">
        <div className="nc-brand">
          <img src="/icon.svg" alt="" />
          netclip
        </div>
        <div className="nc-header-actions">
          <button className="nc-header-btn" onClick={ui.openAdd}>
            <Icon.Plus />
            {t('add.files')}
          </button>
          <button className="nc-header-btn" onClick={() => ui.openQr(origin)}>
            <Icon.Qr />
            {t('header.openOnPhone')}
          </button>
        </div>
      </header>

      <div className="nc-omnibar">
        <Icon.Search />
        <input
          ref={inputRef}
          type="text"
          defaultValue={query}
          placeholder={t('omnibar.placeholder')}
          spellCheck="false"
          autoComplete="off"
          autoCorrect="off"
          aria-label={t('omnibar.placeholderTouch')}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={(e) => {
            composing.current = false
            nc.setQuery(e.currentTarget.value)
          }}
          onChange={(e) => {
            if (!composing.current) nc.setQuery(e.target.value)
          }}
        />
        {query && (
          <button
            className="nc-omnibar-clear"
            onClick={() => {
              inputRef.current.value = ''
              nc.setQuery('')
              focusOmnibar()
            }}
            aria-label={t('action.close')}
          >
            <Icon.Close />
          </button>
        )}
      </div>

      <div className="nc-body">
        {!items.length ? (
          <EmptyState query={query} loading={nc.loading} origin={origin} onQr={() => ui.openQr(origin)} onCopySnippet={ui.copySnippet} />
        ) : (
          <>
            <div className="nc-list">
              {grouped.map((entry) =>
                entry.header ? (
                  <div className="nc-section nc-chrome" key={`h-${entry.header}`}>
                    {t(`group.${entry.header}`)}
                  </div>
                ) : (
                  <div
                    key={entry.item.id}
                    ref={(node) => {
                      if (node) rowRefs.current.set(entry.item.id, node)
                      else rowRefs.current.delete(entry.item.id)
                    }}
                  >
                    <Row
                      item={entry.item}
                      selected={entry.item.id === nc.selectedId}
                      query={query}
                      now={now}
                      onSelect={nc.setSelectedId}
                      onActivate={copySelected}
                    />
                  </div>
                ),
              )}
            </div>
            <Preview
              item={selected}
              text={nc.textOf(selected)}
              hasText={nc.hasFullText(selected)}
              onFetchText={nc.fetchContent}
            />
          </>
        )}
      </div>

      <Footer nc={nc} flash={nc.flashMessage || ui.footerFlash} willSend={willSend} />

      {menuOpen && <ActionMenu actions={actions} onClose={() => setMenuOpen(false)} />}
    </div>
  )
}

function EmptyState({ query, loading, origin, onQr, onCopySnippet }) {
  if (loading) return <div className="nc-empty" />
  if (query) {
    return (
      <div className="nc-empty">
        <div className="nc-empty-title">{t('search.emptyTitle')}</div>
        <div className="nc-empty-hint">{t('search.emptyHint', { q: query })}</div>
      </div>
    )
  }
  const snippet = terminalSnippet(origin)
  return (
    <div className="nc-empty">
      <div className="nc-empty-key">{combo('V')}</div>
      <div className="nc-empty-title">{t('empty.title')}</div>
      <div className="nc-empty-hint">{t('empty.hint')}</div>
      <button className="nc-btn" style={{ marginTop: 'var(--nc-sp-4)' }} onClick={onQr}>
        <Icon.Qr />
        {t('header.openOnPhone')}
        <span style={{ color: 'var(--nc-text-tertiary)' }}>— {t('empty.pair')}</span>
      </button>
      <button className="nc-empty-snippet" onClick={() => onCopySnippet(snippet)} title={t('action.copy')}>
        {t('empty.terminal')} {snippet}
      </button>
    </div>
  )
}
