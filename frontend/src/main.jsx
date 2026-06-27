import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// Approach 2: visualViewport CSS variable for accurate Android nav bar height.
// Sets --vh to the actual visible height so layouts can use var(--vh, 100dvh).
function updateVh() {
  const h = window.visualViewport?.height ?? window.innerHeight
  document.documentElement.style.setProperty('--vh', `${h}px`)
}
updateVh()
window.visualViewport?.addEventListener('resize', updateVh)
window.addEventListener('resize', updateVh)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
