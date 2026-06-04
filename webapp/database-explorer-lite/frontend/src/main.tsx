import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { useUIStore } from './store/uiStore'

document.documentElement.setAttribute('data-theme', useUIStore.getState().theme)

useUIStore.subscribe((state, previousState) => {
  if (state.theme !== previousState.theme) {
    document.documentElement.setAttribute('data-theme', state.theme)
  }
})

createRoot(document.getElementById('root')!).render(<App />)
