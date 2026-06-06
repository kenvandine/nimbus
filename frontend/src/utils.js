let _kioskFallback = null

export function setKioskFallback(fn) {
  _kioskFallback = fn
}

function isLocalAccess() {
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

/**
 * Open an app URL.  Strategy:
 *
 * - On local access (localhost / kiosk): always use the in-app iframe overlay
 *   so the user has a visible "Back to Nimbus" path. An "Open in new tab" link
 *   in the overlay handles apps that refuse to be embedded (X-Frame-Options).
 * - On remote access: open in a new tab (no iframe restriction concerns).
 */
export function openApp(url, meta = {}) {
  if (isLocalAccess() && _kioskFallback) {
    _kioskFallback(url, meta)
    return
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (!opened && isLocalAccess()) {
    window.location.href = url
  }
}

function rewriteToLocalhost(url) {
  try {
    const parsed = new URL(url)
    parsed.hostname = 'localhost'
    return parsed.toString()
  } catch {
    return url
  }
}
