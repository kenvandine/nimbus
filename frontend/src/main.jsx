import React from 'react'
import ReactDOM from 'react-dom/client'
import './theme.css'
import App from './App.jsx'
import { TranslationProvider } from './i18n.jsx'

// Sets --vh to the layout viewport height so the app fills the screen without
// being clipped by the Android nav bar. Uses innerHeight (not visualViewport)
// so the value stays stable while the browser address bar shows/hides.
function updateVh() {
  document.documentElement.style.setProperty('--vh', `${window.innerHeight}px`)
}
updateVh()
window.addEventListener('resize', updateVh)

// Optional theme override, served from a writable $SNAP_COMMON directory
// (see backend/main.py). Appended to <head> at runtime — rather than
// authored as a <link> in index.html — so it's guaranteed to land after
// theme.css in the cascade regardless of where Vite places its own
// generated stylesheet link at build time. A 404 here (the common case,
// nothing overridden) is silently ignored by the browser.
const overrideLink = document.createElement('link')
overrideLink.rel = 'stylesheet'
overrideLink.href = '/theme/override.css'
document.head.appendChild(overrideLink)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <TranslationProvider>
      <App />
    </TranslationProvider>
  </React.StrictMode>
)
