import { create } from 'zustand'

export type ToastType = 'info' | 'success' | 'warning' | 'error'
export type Theme = 'cosmos' | 'arctic' | 'neon-bio' | 'amber-lab' | 'epfl' | 'arcane-study'

const THEME_STORAGE_KEY = 'molviz-theme'
const VALID_THEMES = new Set<Theme>([
  'cosmos',
  'arctic',
  'neon-bio',
  'amber-lab',
  'epfl',
  'arcane-study',
])

export type ToastItem = {
  id: string
  message: string
  type: ToastType
}

type UIState = {
  theme: Theme
  setTheme: (theme: Theme) => void
  toasts: ToastItem[]
  pushToast: (message: string, type?: ToastType) => void
  dismissToast: (id: string) => void
  activePlotId: string | null
  setActivePlotId: (id: string | null) => void
}

function makeToastId() {
  return `toast_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function getInitialTheme(): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  return VALID_THEMES.has(stored as Theme) ? (stored as Theme) : 'cosmos'
}

export const useUIStore = create<UIState>((set) => ({
  theme: getInitialTheme(),
  setTheme: (theme) => {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
    set({ theme })
  },
  toasts: [],
  pushToast: (message, type = 'info') =>
    set((s) => ({
      toasts: [...s.toasts, { id: makeToastId(), message, type }]
    })),
  dismissToast: (id) =>
    set((s) => ({
      toasts: s.toasts.filter((t) => t.id !== id)
    })),
  activePlotId: null,
  setActivePlotId: (id) => set({ activePlotId: id }),
}))
