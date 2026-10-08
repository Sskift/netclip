import { useEffect, useRef, useState } from 'react'

export default function ResizeHandle({ containerRef, storageKey, label, controls, defaultSize, defaultRatio,
  minSize = 180, maxSize = 600, minRemaining = 320, className = '' }) {
  const preferred = useRef(undefined), drag = useRef(null), apply = useRef(null)
  const [size, setSize] = useState(minSize), [limit, setLimit] = useState(maxSize)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (preferred.current === undefined) {
      try {
        const saved = Number(localStorage.getItem(storageKey))
        preferred.current = Number.isFinite(saved) && saved > 0 ? saved : null
      } catch { preferred.current = null }
    }
    const measure = () => {
      const width = container.clientWidth
      if (!width) return
      const maximum = Math.max(minSize, Math.min(maxSize, width - minRemaining))
      const next = Math.round(Math.max(minSize, Math.min(maximum, preferred.current ?? defaultSize ?? width * defaultRatio)))
      container.style.setProperty('--nw-pane-width', `${next}px`)
      setSize(next); setLimit(maximum)
      return next
    }
    apply.current = (next) => { preferred.current = next; return measure() }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef, storageKey, defaultSize, defaultRatio, minSize, maxSize, minRemaining])

  const save = () => {
    try {
      if (preferred.current === null) localStorage.removeItem(storageKey)
      else localStorage.setItem(storageKey, String(preferred.current))
    } catch { /* Resizing still works when storage is unavailable. */ }
  }
  const resize = (next) => {
    const actual = apply.current(Math.max(minSize, Math.min(limit, next)))
    preferred.current = actual
  }
  const finish = () => { if (drag.current) { drag.current = null; setDragging(false); save() } }
  const reset = () => { apply.current(null); save() }

  return <div className={`nw-resize-handle nc-chrome ${className}`} role="separator" tabIndex={0}
    aria-label={label} aria-orientation="vertical" aria-controls={controls}
    aria-valuemin={minSize} aria-valuemax={limit} aria-valuenow={size} aria-valuetext={`${size} pixels`}
    title="Drag to resize · Double-click to reset" data-dragging={dragging}
    onPointerDown={(e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.currentTarget.focus({ preventScroll: true })
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { x: e.clientX, size }
      setDragging(true)
    }}
    onPointerMove={(e) => { if (drag.current) resize(drag.current.size + e.clientX - drag.current.x) }}
    onPointerUp={(e) => { finish(); if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
    onPointerCancel={finish} onLostPointerCapture={finish} onDoubleClick={reset}
    onKeyDown={(e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(e.key)) return
      e.preventDefault(); e.stopPropagation()
      if (e.key === 'Enter') { reset(); return }
      resize(e.key === 'Home' ? minSize : e.key === 'End' ? limit : size + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 40 : 10))
      save()
    }} />
}
