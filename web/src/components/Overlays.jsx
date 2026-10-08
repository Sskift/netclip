import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { qrPath } from '../lib/qr.js'
import { t } from '../lib/i18n.js'
import { capabilities, readPaste } from '../lib/clipboard.js'
import * as Icon from './Icons.jsx'
import { MenuItems } from './Menu.jsx'

/** Esc closes; the backdrop closes; focus is trapped loosely by autofocusing the panel. */
function useDismiss(onClose) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
}

export function Modal({ title, onClose, children, footer }) {
  useDismiss(onClose)
  return (
    <div className="nc-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="nc-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="nc-modal-header nc-chrome">
          <span>{title}</span>
          <button className="nc-modal-close" onClick={onClose} aria-label={t('action.close')}>
            <Icon.Close />
          </button>
        </div>
        <div className="nc-modal-body nc-content">{children}</div>
        {footer}
      </div>
    </div>
  )
}

export function Sheet({ title, onClose, children }) {
  useDismiss(onClose)
  return (
    <>
      {/* Closes on click, not touchstart: dismissing on finger-down lets the follow-up
          compatibility click land on whatever the sheet was covering. */}
      <div className="nc-scrim nc-scrim--sheet" onClick={onClose} />
      <div className="nc-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="nc-sheet-header nc-chrome">
          <span>{title}</span>
          <button className="nc-modal-close" onClick={onClose} aria-label={t('action.close')}>
            <Icon.Close />
          </button>
        </div>
        {children}
      </div>
    </>
  )
}

/* --------------------------------------------------------------------- QR */

export function QrCode({ value, small }) {
  const { d, viewBox } = qrPath(value)
  return (
    <svg className={`nc-qr${small ? ' nc-qr--sm' : ''}`} viewBox={viewBox} shapeRendering="crispEdges">
      <path d={d} />
    </svg>
  )
}

export function QrModal({ url, unreachable, onClose }) {
  // Rendering a code for an address nothing on the network can reach is worse than
  // rendering no code: it scans cleanly and then just fails to connect.
  if (unreachable) {
    return (
      <Modal title={t('qr.title')} onClose={onClose}>
        <div style={{ display: 'grid', gap: 'var(--nc-sp-3)', textAlign: 'center' }}>
          <p style={{ margin: 0, color: 'var(--nc-text)' }}>{t('qr.unreachable')}</p>
          <p style={{ margin: 0, color: 'var(--nc-text-tertiary)' }}>{t('qr.unreachableHint')}</p>
        </div>
      </Modal>
    )
  }
  return (
    <Modal title={t('qr.title')} onClose={onClose}>
      <div style={{ display: 'grid', justifyItems: 'center', gap: 'var(--nc-sp-4)' }}>
        <QrCode value={url} />
        <code style={{ fontSize: 'var(--nc-fs-13)', color: 'var(--nc-text-secondary)' }}>{url}</code>
        <p style={{ margin: 0, color: 'var(--nc-text-tertiary)', textAlign: 'center' }}>{t('qr.hint')}</p>
      </div>
    </Modal>
  )
}

/* ----------------------------------------------------- manual copy fallback */

/**
 * Shown when the browser refused to copy. Deliberately a <div>, not a <textarea>: a
 * textarea would summon the iOS keyboard at the exact moment the instruction is
 * "long-press → Copy". The text is pre-selected so the user only has to confirm.
 */
export function ManualCopy({ text, onClose }) {
  const ref = useRef(null)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(node)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [text])

  return (
    <Modal title={t('manual.title')} onClose={onClose}>
      <div className="nc-manual" ref={ref} dir="auto">
        {text}
      </div>
      <p className="nc-manual-hint">{capabilities.touch ? t('manual.touch') : t('manual.desktop')}</p>
    </Modal>
  )
}

/* ---------------------------------------------------------------- confirm */

export function Confirm({ message, confirmLabel, onConfirm, onClose }) {
  return (
    <Modal title={message} onClose={onClose}>
      <div style={{ display: 'flex', gap: 'var(--nc-sp-2)', justifyContent: 'flex-end' }}>
        <button className="nc-btn nc-btn--ghost" onClick={onClose}>
          {t('action.close')}
        </button>
        <button
          className="nc-btn nc-btn--danger"
          onClick={() => {
            onConfirm()
            onClose()
          }}
          autoFocus
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

/* -------------------------------------------------------------- drop zone */

export function DropOverlay({ count }) {
  return (
    <div className="nc-drop nc-chrome">
      <div className="nc-drop-inner">
        <Icon.Download style={{ width: 28, height: 28 }} />
        <span>{t('drop.title')}</span>
        {count > 1 && (
          <span style={{ fontSize: 'var(--nc-fs-13)', opacity: 0.8 }}>{t('drop.files', { n: count })}</span>
        )}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- snackbar */

export function Snackbar({ label, actionLabel, onAction, desktop }) {
  return (
    <div className={`nc-snackbar nc-chrome${desktop ? ' nc-snackbar--desktop' : ''}`} role="status">
      <span>{label}</span>
      {actionLabel && <button onClick={onAction}>{actionLabel}</button>}
    </div>
  )
}

/* -------------------------------------------------------------- add sheet */

export function AddSheet({ onSend, onFiles, onClose, onOpenDrive }) {
  const ref = useRef(null)
  const [empty, setEmpty] = useState(true)

  useEffect(() => {
    // This is a compose surface — the keyboard is wanted here.
    const id = setTimeout(() => ref.current?.focus(), 60)
    return () => clearTimeout(id)
  }, [])

  const send = () => {
    const text = ref.current?.innerText ?? ''
    if (!text.trim()) return
    onSend(text)
    onClose()
  }

  const pickFiles = (accept, capture) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = !capture
    if (capture) input.capture = 'environment'
    input.onchange = () => {
      if (input.files?.length) {
        onFiles([...input.files])
        onClose()
      }
    }
    input.click()
  }

  return (
    <Sheet title={t('add.title')} onClose={onClose}>
      <div className="nc-sheet-body">
        <div
          ref={ref}
          className="nc-compose"
          contentEditable="plaintext-only"
          role="textbox"
          aria-multiline="true"
          data-placeholder={t('add.placeholder')}
          onInput={(e) => setEmpty(!e.currentTarget.innerText.trim())}
          onPaste={(e) => {
            // An image pasted into the composer should become an item, not an inline blob.
            const { files } = readPaste(e)
            if (files.length) {
              e.preventDefault()
              onFiles(files)
              onClose()
            }
          }}
        />
        <div className="nc-compose-row">
          <button className="nc-btn" onClick={() => { onClose(); onOpenDrive() }}>
            <Icon.Cloud />
            {t('header.drive')}
          </button>
          <button className="nc-btn" onClick={() => pickFiles('image/*')}>
            <Icon.Image />
            {t('add.photos')}
          </button>
          <button className="nc-btn" onClick={() => pickFiles('image/*', true)}>
            <Icon.Camera />
            {t('add.camera')}
          </button>
        </div>
        <button
          className="nc-btn nc-btn--primary nc-btn--wide"
          style={{ height: 52, marginTop: 'var(--nc-sp-3)' }}
          disabled={empty}
          onClick={send}
        >
          {t('action.send')}
        </button>
      </div>
    </Sheet>
  )
}

/* ------------------------------------------------------------ action list */

export function ActionSheet({ title, actions, onClose }) {
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="nc-sheet-list" role="menu" aria-label={title}>
        <MenuItems actions={actions} onChoose={(action) => { onClose(); action.run() }} />
      </div>
    </Sheet>
  )
}
