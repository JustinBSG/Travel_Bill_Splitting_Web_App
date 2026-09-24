import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './app/install' // capture beforeinstallprompt before React mounts
import './app/theme' // light / dark mode (follows the system when set to System)
import './lib/i18n'
import './index.css'
import { App } from './app/App'

registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
