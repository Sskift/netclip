import { useEffect, useState } from 'react'
import * as api from '../lib/api.js'
import { t, ALT, MOD, isMac } from '../lib/i18n.js'
import { absoluteTime, expiresIn, formatBytes, relativeTime } from '../lib/time.js'
import { dimensions, prettyUrl, safeUrl, typeLabel } from '../lib/format.js'
import { QrCode } from './Overlays.jsx'
import * as Icon from './Icons.jsx'

const MOD_S = isMac ? `${MOD}S` : `${MOD}+S`

function MetaRow({ label, children }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

export default function Preview({ item, text, hasText, onFetchText }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    // Catch: the item may have expired or been deleted on another device between the list
    // response and this fetch, and an unhandled rejection here would be noise on every
    // selection change.
    if (item?.kind === 'text' && !hasText) onFetchText?.(item)?.catch?.(() => {})
  }, [item, hasText, onFetchText])

  if (!item) return <div className="nc-preview" />

  const url = item.kind === 'text' && item.flavor === 'url' ? safeUrl(text || item.preview) : null
  const showQr = url && (text || item.preview).length < 250
  const dims = dimensions(item)

  return (
    <div className="nc-preview">
      <div className="nc-preview-header">
        <span className="nc-preview-title">
          {item.kind !== 'text' ? item.filename || typeLabel(item) : typeLabel(item)}
        </span>
        {dims && <span>· {dims}</span>}
      </div>

      {/* The content region. No user-select:none and no wrapper anchor anywhere below —
          the browser's own right-click → Copy image is the only image-copy path there is. */}
      <div className="nc-preview-body nc-content">
        {item.kind === 'image' ? (
          <img
            src={api.rawUrl(item)}
            alt={item.filename || t('kind.image')}
            className={item.mime === 'image/png' ? 'nc-checker' : undefined}
            style={{ aspectRatio: item.width && item.height ? `${item.width}/${item.height}` : undefined }}
            draggable
          />
        ) : item.kind === 'file' ? (
          <div className="nc-preview-link">
            <Icon.File style={{ width: 48, height: 48 }} />
            <div className="nc-url" dir="auto">{item.filename}</div>
            <div className="nc-caption">{formatBytes(item.bytes)}</div>
          </div>
        ) : showQr ? (
          <div className="nc-preview-link">
            <QrCode value={url.href} small />
            <div className="nc-url" dir="auto">
              {prettyUrl(url.href)}
            </div>
            <div className="nc-caption">{t('hint.qrCaption')}</div>
          </div>
        ) : hasText ? (
          <pre className="nc-preview-text" data-mono={item.flavor === 'json'} dir="auto" tabIndex={0}>
            {text}
          </pre>
        ) : (
          <div style={{ color: 'var(--nc-text-tertiary)' }}>{t('action.loading')}</div>
        )}
      </div>

      <dl className="nc-meta">
        <MetaRow label={t('meta.type')}>
          {[
            typeLabel(item),
            item.kind === 'image' ? item.mime?.replace('image/', '').toUpperCase() : null,
            formatBytes(item.bytes),
            item.kind === 'text' && item.lines > 1 ? t('meta.lines', { n: item.lines }) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </MetaRow>

        <MetaRow label={t('meta.added')}>
          {absoluteTime(item.createdAt)}
          {item.source ? ` · ${t('meta.from', { device: item.source })}` : ''}
        </MetaRow>

        <MetaRow label={t('meta.expires')}>
          {item.pinned || !item.expiresAt ? (
            t('meta.never')
          ) : (
            <>
              {expiresIn(item.expiresAt, now)}
              <span className="nc-hintkey">{t('meta.keepForever', { key: `${ALT}P` })}</span>
            </>
          )}
        </MetaRow>

        {item.copyCount > 0 && (
          <MetaRow label={t('meta.copied')}>{t('meta.copiedTimes', { n: item.copyCount })}</MetaRow>
        )}
      </dl>

      <div className="nc-actionrow">
        {item.kind !== 'text' && (
          <>
            <a className="nc-btn" href={api.rawUrl(item, { download: true })} download={item.filename || ''}>
              <Icon.Download />
              {t('action.download')}
            </a>
            <span className="nc-kbd">{MOD_S}</span>
            {item.kind === 'image' && <span>{t('hint.longPressDesktop')}</span>}
          </>
        )}
        {url && (
          <a className="nc-btn" href={url.href} target="_blank" rel="noopener noreferrer">
            <Icon.External />
            {t('action.open')}
          </a>
        )}
        {item.kind === 'text' && !hasText && (
          <span style={{ color: 'var(--nc-text-tertiary)' }}>{relativeTime(item.updatedAt, now)}</span>
        )}
      </div>
    </div>
  )
}
