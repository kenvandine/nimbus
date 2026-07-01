let _kioskFallback = null

// Apps that set X-Frame-Options: DENY / frame-ancestors 'none' — cannot be
// embedded in an iframe regardless of origin.  Open directly instead.
const NO_IFRAME_APPS = new Set(['openclaw'])

export function setKioskFallback(fn) {
  _kioskFallback = fn
}

export function isLocalAccess() {
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

export function openApp(url, meta = {}) {
  // Always rewrite the app URL's hostname to match the current page's hostname
  // so that links work regardless of whether the user is on the LAN IP,
  // nimbus.local (mDNS), or a Tailscale address.
  const rewritten = rewriteToCurrentHost(url)

  if (isLocalAccess()) {
    if (_kioskFallback) {
      // Browsers block HTTP iframes inside HTTPS pages (mixed content).
      // Fall back to remoteOnly so the user sees a message rather than a blank frame.
      let mixedContent = false
      try {
        mixedContent =
          window.location.protocol === 'https:' &&
          new URL(rewritten).protocol === 'http:'
      } catch {
        // relative or invalid URL — no mixed-content concern
      }
      if (NO_IFRAME_APPS.has(meta.id) || mixedContent) {
        _kioskFallback(rewritten, { ...meta, remoteOnly: true, remoteUrl: rewritten })
      } else {
        _kioskFallback(rewritten, meta)
      }
      return
    }
    window.location.href = rewritten
    return
  }
  // Use a programmatic anchor click rather than window.open(url, '_blank', 'noopener,noreferrer').
  // window.open with the 'noopener' feature string always returns null in modern browsers,
  // which causes the window.location.href fallback to fire too — double-navigation.
  const a = document.createElement('a')
  a.href = rewritten
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

function rewriteToCurrentHost(url) {
  try {
    const parsed = new URL(url)
    parsed.hostname = window.location.hostname
    return parsed.toString()
  } catch {
    return url
  }
}
