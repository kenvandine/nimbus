let _kioskFallback = null

export function setKioskFallback(fn) {
  _kioskFallback = fn
}

function isLocalAccess() {
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

/**
 * Open a URL in a new tab for remote users.
 * On local/kiosk access (localhost / 127.0.0.1) use the iframe overlay
 * so the user always has a visible way back to Nimbus.
 */
export function openApp(url, meta = {}) {
  if (isLocalAccess()) {
    if (_kioskFallback) _kioskFallback(url, meta)
    else window.location.href = url
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
