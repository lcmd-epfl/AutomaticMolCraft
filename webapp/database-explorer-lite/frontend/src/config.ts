const envBackend = (import.meta.env.VITE_BACKEND_URL as string | undefined)?.trim()

export const BACKEND =
  envBackend && envBackend.length > 0
    ? envBackend.replace(/\/$/, '')
    : import.meta.env.DEV
      ? 'http://localhost:8000'
      : ''

