import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check } from './Icons.jsx'

export function MenuItems({ actions, onChoose, tabIndex = 0 }) {
  return actions.map((action) => {
    if (action.separator) return <div className="nc-menu-sep" role="separator" key={action.key} />
    const Tag = action.href ? 'a' : 'button'
    return <Tag key={action.key} className={`nc-menu-item${action.danger ? ' nc-menu-item--danger' : ''}`}
      role={action.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={action.checked}
      disabled={action.disabled} tabIndex={tabIndex} href={action.href} download={action.download}
      onMouseMove={(e) => { if (!action.disabled) e.currentTarget.focus({ preventScroll: true }) }}
      onClick={() => onChoose(action)}>
      {action.icon}<span>{action.label}</span><span className="nc-spacer" />
      {action.checked && <Check />}{action.hint && <span className="nc-kbd">{action.hint}</span>}
    </Tag>
  })
}

export default function Menu({ actions, onClose, anchor, label, className = '' }) {
  const panel = useRef(null), returnFocus = useRef(anchor || document.activeElement), focused = useRef(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [position, setPosition] = useState(null)
  const close = (restore = false) => {
    if (restore && returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true })
    closeRef.current()
  }
  useLayoutEffect(() => {
    const place = () => {
      if (!anchor) return
      const box = anchor.getBoundingClientRect(), popup = panel.current.getBoundingClientRect()
      const below = box.bottom + 6
      setPosition({ left: Math.max(8, Math.min(box.right - popup.width, innerWidth - popup.width - 8)),
        top: Math.max(8, Math.min(below + popup.height <= innerHeight - 8 ? below : box.top - popup.height - 6, innerHeight - popup.height - 8)) })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [anchor])
  useLayoutEffect(() => {
    if (focused.current || (anchor && !position)) return
    const items = panel.current.querySelectorAll('[role^="menuitem"]:not(:disabled)')
    ;([...items].find((item) => item.getAttribute('aria-checked') === 'true') || items[0])?.focus({ preventScroll: true })
    focused.current = true
  }, [anchor, position])
  useEffect(() => {
    const outside = (e) => { if (!panel.current?.contains(e.target) && !anchor?.contains(e.target)) closeRef.current() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [anchor])
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return }
    if (e.key === 'Tab') { close(true); return }
    const items = [...panel.current.querySelectorAll('[role^="menuitem"]:not(:disabled)')]
    const index = items.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? (index + 1) % items.length : e.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null
    if (next !== null) { e.preventDefault(); e.stopPropagation(); items[next]?.focus(); return }
    if (e.key === ' ' && document.activeElement?.tagName === 'A') { e.preventDefault(); document.activeElement.click() }
  }
  return createPortal(<div ref={panel} className={`nc-menu nc-chrome ${className}`} role="menu" aria-label={label}
    style={anchor ? { ...position, visibility: position ? undefined : 'hidden' } : undefined} onKeyDown={onKeyDown}>
    <MenuItems actions={actions} tabIndex={-1} onChoose={(action) => { close(true); action.run?.() }} />
  </div>, document.body)
}
