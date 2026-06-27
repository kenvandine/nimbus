import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// Sets --vh to the layout viewport height so the app fills the screen without
// being clipped by the Android nav bar. Uses innerHeight (not visualViewport)
// so the value stays stable while the browser address bar shows/hides.
function updateVh() {
  document.documentElement.style.setProperty('--vh', `${window.innerHeight}px`)
}
updateVh()
window.addEventListener('resize', updateVh)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
