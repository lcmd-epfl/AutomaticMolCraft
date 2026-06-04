import React, { useEffect } from 'react'
import { useUIStore } from '../store/uiStore'

const AUTO_DISMISS_MS = 3500

export default function ToastHost() {
  const toasts = useUIStore(s => s.toasts)
  const dismissToast = useUIStore(s => s.dismissToast)

  useEffect(() => {
    if (!toasts.length) return
    const timers = toasts.map(t =>
      window.setTimeout(() => dismissToast(t.id), AUTO_DISMISS_MS)
    )
    return () => {
      for (const id of timers) window.clearTimeout(id)
    }
  }, [toasts, dismissToast])

  if (!toasts.length) return null

  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="true">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span>{t.message}</span>
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

