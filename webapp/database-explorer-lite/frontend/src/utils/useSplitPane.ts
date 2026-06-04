import { useCallback, useRef, useState } from 'react'

export function useSplitPane(key: string, defaultSize: number, min: number, max: number) {
  const [size, setSize] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw !== null) {
        const n = Number(raw)
        if (Number.isFinite(n) && n >= min && n <= max) return n
      }
    } catch {}
    return defaultSize
  })

  const sizeRef = useRef(size)
  sizeRef.current = size

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startSize = sizeRef.current

      const onMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX  // right panel: drag right → shrink, drag left → grow
        const next = Math.max(min, Math.min(max, startSize + delta))
        setSize(next)
        sizeRef.current = next
      }

      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        try { localStorage.setItem(key, String(sizeRef.current)) } catch {}
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [key, min, max]
  )

  return { size, startDrag }
}
