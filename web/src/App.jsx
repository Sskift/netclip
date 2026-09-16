import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from './lib/api.js'
import { useNetclip } from './lib/store.js'
import { capabilities, copyImage, copyText, readDrop, readPaste } from './lib/clipboard.js'
import { t, MOD, isMac } from './lib/i18n.js'
import { phoneUrl, phoneUrlIsUseless } from './lib/qr.js'
import { terminalSnippet } from './lib/format.js'
import Desktop from './components/Desktop.jsx'
import Mobile from './components/Mobile.jsx'
import {
  ActionSheet,
  AddSheet,
  Confirm,
  DropOverlay,
  ManualCopy,
  Modal,
  QrModal,
  Snackbar,
} from './components/Overlays.jsx'
import * as Icon from './components/Icons.jsx'

const DESKTOP_BREAKPOINT = 820

function useIsDesktop() {
  const [wide, setWide] = useState(() => window.innerWidth >= DESKTOP_BREAKPOINT)
  useEffect(() => {
    let timer
    const onResize = () => {
      clearTimeout(timer)
      timer = setTimeout(() => setWide(window.innerWidth >= DESKTOP_BREAKPOINT), 150)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      clearTimeout(timer)
    }
  }, [])
  return wide
}

/** The item id in a /i/:id deep link, if we were opened with one. */
const deepLinkId = () => {
  const match = /^\/i\/(\d+)$/.exec(window.location.pathname)
  return match ? Number(match[1]) : null
}

export default function App() {
  const nc = useNetclip()
  const isDesktop = useIsDesktop()

  const [overlay, setOverlay] = useState(null)
  const [dropCount, setDropCount] = useState(0)
  const [footerFlash, setFooterFlash] = useState(null)
  const dragDepth = useRef(0)
  const flashTimer = useRef(null)

  const closeOverlay = useCallback(() => setOverlay(null), [])

  const flashFooter = useCallback((message, kind = 'info') => {
    clearTimeout(flashTimer.current)
    setFooterFlash({ message, kind })
    flashTimer.current = setTimeout(() => setFooterFlash(null), kind === 'error' ? 5000 : 2000)
  }, [])

  /* ------------------------------------------------------------- deep link */

  const deepLink = useRef(deepLinkId())
  const [highlightId, setHighlightId] = useState(null)
  useEffect(() => {
    if (deepLink.current == null || !nc.items.length) return
    const target = nc.items.find((i) => i.id === deepLink.current)
    if (target) {
      nc.setSelectedId(target.id)
      // On mobile there is no selection to see, so the card scrolls itself into view and
      // wears the fresh ring instead — otherwise scanning an item's QR would just open
      // the app and leave you to find the thing yourself.
      setHighlightId(target.id)
    }
    deepLink.current = null
  }, [nc])

  /* ------------------------------------------------------------- ingesting */

  const send = useCallback(
    async ({ files, text }) => {
      try {
        if (files?.length) {
          const results = await nc.addFiles(files)
          const created = results.some((r) => r.created)
          flashFooter(created ? t('footer.sent') : t('footer.moved'))
        } else if (text?.trim()) {
          const res = await nc.addText(text)
          flashFooter(res.created ? t('footer.sent') : t('footer.moved'))
        }
      } catch (err) {
        flashFooter(err.message, 'error')
      }
    },
    [nc, flashFooter],
  )

  // Paste always sends. The one exception is a real compose surface, which owns its own
  // paste handling — anywhere else, including the omnibar, ⌘V means "send this".
  useEffect(() => {
    const onPaste = (event) => {
      const active = document.activeElement
      if (active?.closest?.('.nc-compose, .nc-manual')) return

      const { files, text } = readPaste(event)
      if (!files.length && !text.trim()) return
      event.preventDefault()
      send({ files, text })
    }
    document.addEventListener('paste', onPaste, true)
    return () => document.removeEventListener('paste', onPaste, true)
  }, [send])

  // Drag & drop, with counter-based enter/leave tracking because dragleave also fires
  // for every child element the pointer crosses.
  useEffect(() => {
    if (!isDesktop) return

    const hasPayload = (e) =>
      [...(e.dataTransfer?.types || [])].some((type) => type === 'Files' || type === 'text/plain')

    const onEnter = (e) => {
      if (!hasPayload(e)) return
      e.preventDefault()
      dragDepth.current++
      setDropCount(e.dataTransfer?.items?.length || 1)
    }
    const onOver = (e) => {
      if (hasPayload(e)) e.preventDefault()
    }
    const onLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDropCount(0)
    }
    const onDrop = (e) => {
      e.preventDefault()
      dragDepth.current = 0
      setDropCount(0)
      const { files, text } = readDrop(e)
      const images = files.filter((f) => f.type.startsWith('image/') || f.type.startsWith('text/'))
      const skipped = files.find((f) => !images.includes(f))
      if (skipped) flashFooter(t('drop.rejected', { name: skipped.name }), 'error')
      if (images.length || text) send({ files: images, text: images.length ? '' : text })
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [isDesktop, send, flashFooter])

  /* ------------------------------------------------------------------- ui */

  /**
   * Always downloads from the server, for text as well as images. The client only holds
   * the full body of items small enough to be inlined, so building the file locally would
   * silently save the 300-character preview for exactly the long items worth saving.
   */
  const download = useCallback((item) => {
    const link = document.createElement('a')
    link.href = api.rawUrl(item, { download: true })
    link.download = item.kind === 'image' ? item.filename || `netclip-${item.id}` : `netclip-${item.id}.txt`
    document.body.appendChild(link)
    link.click()
    link.remove()
  }, [])

  const ui = useMemo(
    () => ({
      modalOpen: overlay !== null,
      footerFlash,
      flashFooter,
      download,
      highlightId,
      copyImage: (item) =>
        copyImage(api.rawUrl(item)).catch((err) => {
          flashFooter(err?.message === 'unavailable' ? t('hint.longPressIOS') : t('manual.title'), 'error')
          throw err
        }),
      copySnippet: (text) => {
        if (copyText(text)) flashFooter(t('action.copied'))
        else setOverlay({ type: 'manual', text })
      },
      openQr: (url) => setOverlay({ type: 'qr', url }),
      openManual: (text) => setOverlay({ type: 'manual', text }),
      openCurl: () => setOverlay({ type: 'curl' }),
      openAdd: () => setOverlay({ type: 'add' }),
      openCardActions: (item, extra) => setOverlay({ type: 'card', item, extra }),
      confirmClearAll: () => setOverlay({ type: 'confirmClear' }),
    }),
    [overlay, footerFlash, flashFooter, download, highlightId],
  )

  /* --------------------------------------------------------------- render */

  const origin = phoneUrl(nc.info)

  const cardActions = (item, extra) => {
    const isText = item.kind === 'text'
    return [
      extra?.setExpanded && isText
        ? {
            key: 'expand',
            label: t('action.showFull'),
            icon: <Icon.Expand />,
            disabled: !nc.hasFullText(item),
            run: () => extra.setExpanded((v) => !v),
          }
        : null,
      isText && {
        key: 'copy',
        label: t('action.copy'),
        icon: <Icon.Copy />,
        run: () => {
          const result = nc.copy(item)
          if (result === 'manual') setOverlay({ type: 'manual', text: nc.textOf(item) })
          // 'pending' means the body isn't in memory yet. Copying after an await would
          // lose the gesture, so pull it down and let the card's own button do the copy.
          else if (result === 'pending') flashFooter(t('action.tapToCopy'))
        },
      },
      {
        key: 'qr',
        label: t('action.showQr'),
        icon: <Icon.Qr />,
        run: () => setOverlay({ type: 'qr', url: phoneUrl(nc.info, `/i/${item.id}`) }),
      },
      {
        key: 'save',
        // On iOS a download lands in Files, never in Photos — say so rather than implying otherwise.
        label: item.kind === 'image' && capabilities.ios ? t('action.saveToFiles') : t('action.download'),
        icon: <Icon.Download />,
        run: () => download(item),
      },
      {
        key: 'pin',
        label: item.pinned ? t('action.unpin') : t('action.pin'),
        icon: <Icon.Pin filled={item.pinned} />,
        run: () => nc.togglePin(item),
      },
      { key: 'sep', separator: true },
      { key: 'delete', label: t('action.delete'), icon: <Icon.Trash />, danger: true, run: () => nc.remove(item) },
    ].filter(Boolean)
  }

  return (
    <>
      {isDesktop ? <Desktop nc={nc} ui={ui} /> : <Mobile nc={nc} ui={ui} />}

      {dropCount > 0 && <DropOverlay count={dropCount} />}

      {nc.undoTarget && (
        <Snackbar
          label={t('snackbar.deleted')}
          actionLabel={t('snackbar.undo')}
          onAction={nc.undoDelete}
          desktop={isDesktop}
        />
      )}

      {overlay?.type === 'qr' && (
        <QrModal url={overlay.url} unreachable={phoneUrlIsUseless(nc.info)} onClose={closeOverlay} />
      )}
      {overlay?.type === 'manual' && <ManualCopy text={overlay.text} onClose={closeOverlay} />}
      {overlay?.type === 'add' && (
        <AddSheet
          onSend={(text) => send({ text })}
          onFiles={(files) => send({ files })}
          onClose={closeOverlay}
        />
      )}
      {overlay?.type === 'card' && (
        <ActionSheet
          title={t('action.more')}
          actions={cardActions(overlay.item, overlay.extra)}
          onClose={closeOverlay}
        />
      )}
      {overlay?.type === 'confirmClear' && (
        <Confirm
          message={t('confirm.deleteAll')}
          confirmLabel={t('action.deleteAll')}
          onConfirm={nc.clearAll}
          onClose={closeOverlay}
        />
      )}
      {overlay?.type === 'curl' && <CurlModal origin={origin} onClose={closeOverlay} onCopy={ui.copySnippet} />}
    </>
  )
}

function CurlModal({ origin, onClose, onCopy }) {
  const base = String(origin).replace(/\/+$/, '')
  const lines = [
    terminalSnippet(base),
    `curl -sT- ${base}/api/items < file.txt`,
    `curl -s -X POST ${base}/api/items/file -H 'content-type: image/png' \\\n  -H 'x-filename: shot.png' --data-binary @shot.png`,
  ]
  return (
    <Modal title={t('action.curl')} onClose={onClose}>
      <div style={{ display: 'grid', gap: 'var(--nc-sp-2)' }}>
        {lines.map((line) => (
          <button key={line} className="nc-empty-snippet" style={{ margin: 0 }} onClick={() => onCopy(line)}>
            {line}
          </button>
        ))}
        <p style={{ color: 'var(--nc-text-tertiary)', margin: 0 }}>
          {capabilities.touch ? t('manual.touch') : `${isMac ? MOD : MOD + '+'}C`}
        </p>
      </div>
    </Modal>
  )
}
