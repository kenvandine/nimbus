let _kioskFallback = null

export function setKioskFallback(fn) {
  _kioskFallback = fn
}

/**
 * Open a URL in a new tab when the browser allows it.
 * When popups are blocked (kiosk mode), window.open returns null and we
 * invoke the kiosk fallback (iframe overlay) instead.
 */
export function openApp(url, meta = {}) {
  const win = window.open(url, '_blank', 'noopener,noreferrer')
  if (!win) {
    if (_kioskFallback) _kioskFallback(url, meta)
    else window.location.href = url
  }
}
