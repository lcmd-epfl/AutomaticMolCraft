import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Palette } from 'lucide-react'
import { useUIStore, type Theme } from '../store/uiStore'

const THEMES: Array<{ id: Theme; label: string; dot: string }> = [
  { id: 'cosmos', label: 'Cosmos', dot: '#38bdf8' },
  { id: 'arctic', label: 'Arctic', dot: '#0284c7' },
  { id: 'neon-bio', label: 'Neon Bio', dot: '#10b981' },
  { id: 'amber-lab', label: 'Amber Lab', dot: '#f59e0b' },
  { id: 'epfl', label: 'EPFL', dot: '#ff0000' },
  { id: 'arcane-study', label: 'Arcane Study', dot: '#c084fc' },
]

export default function TopBar() {
  const theme = useUIStore(s => s.theme)
  const setTheme = useUIStore(s => s.setTheme)
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const activeTheme = THEMES.find(t => t.id === theme) ?? THEMES[0]

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  return (
    <div className="topbar">
      <div className="topbar-brand">
        <img src="/logo-mark.svg" className="topbar-brand-logo" width={28} height={28} alt="" />
        <span>AutomaticMolCraft</span>
      </div>
      <div className="topbar-actions" ref={menuRef}>
        <button
          type="button"
          className="theme-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
        >
          <Palette size={14} strokeWidth={2} />
          <span className="theme-dot" style={{ background: activeTheme.dot }} />
          <span>{activeTheme.label}</span>
          <ChevronDown size={14} strokeWidth={2} />
        </button>
        {open && (
          <div className="theme-dropdown" role="menu" aria-label="Choose theme">
            {THEMES.map(t => (
              <button
                key={t.id}
                type="button"
                role="menuitemradio"
                aria-checked={theme === t.id}
                className={`theme-option ${theme === t.id ? 'active' : ''}`}
                onClick={() => {
                  setTheme(t.id)
                  setOpen(false)
                }}
              >
                <span className="theme-dot" style={{ background: t.dot }} />
                <span>{t.label}</span>
                {theme === t.id && <Check size={14} strokeWidth={2} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
