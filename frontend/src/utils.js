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
 * 1. Always try window.open first — a new tab is free of iframe restrictions
 *    (X-Frame-Options, CSP frame-ancestors, mixed-content rules) that would
 *    silently block or refuse third-party apps like OpenClaw.
 *
 * 2. If window.open was blocked (popup blocker or kiosk full-screen mode)
 *    AND we're on local/kiosk access, fall back to the in-app iframe overlay
 *    so the user still has a visible "Back to Nimbus" path.
 *    Last resort: full-page navigation (user can press Back).
 */
export function openApp(url, meta = {}) {
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (!opened && isLocalAccess()) {
    if (_kioskFallback) _kioskFallback(url, meta)
    else window.location.href = url
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
