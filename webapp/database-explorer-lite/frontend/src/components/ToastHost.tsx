import React, { useEffect, useRef } from 'react'
import { useUIStore } from '../store/uiStore'
import type { ToastType } from '../store/uiStore'

// Errors stay until dismissed; warnings linger longer than info/success.
const AUTO_DISMISS_MS: Record<ToastType, number | null> = {
  info: 3500,
  success: 3500,
  warning: 6000,
  error: null,
}

export default function ToastHost() {
  const toasts = useUIStore(s => s.toasts)
  const dismissToast = useUIStore(s => s.dismissToast)
  const timers = useRef(new Map<string, number>())

  useEffect(() => {
    const live = new Set(toasts.map(t => t.id))
    for (const t of toasts) {
      const ms = AUTO_DISMISS_MS[t.type]
      if (ms == null || timers.current.has(t.id)) continue
      timers.current.set(t.id, window.setTimeout(() => dismissToast(t.id), ms))
    }
    for (const [id, timer] of timers.current) {
      if (!live.has(id)) {
        window.clearTimeout(timer)
        timers.current.delete(id)
      }
    }
  }, [toasts, dismissToast])

  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer)
  }, [])

  if (!toasts.length) return null

  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="true">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span>{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                t.action?.onAction()
                dismissToast(t.id)
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            className="toast-close"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss notification"
          >
            x
          </button>
        </div>
      ))}
    </div>
  )
}
