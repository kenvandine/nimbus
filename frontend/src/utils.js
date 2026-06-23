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
  if (isLocalAccess()) {
    // Rewrite any external IP/hostname to localhost so the request resolves
    // on the device itself.  The LXD proxy listens on 0.0.0.0 so localhost
    // always reaches it; the LAN IP only works from remote clients.
    const localUrl = rewriteToLocalhost(url)
    if (_kioskFallback) {
      // Browsers block HTTP iframes inside HTTPS pages (mixed content).
      // Fall back to remoteOnly so the user sees a message rather than a blank frame.
      const mixedContent =
        window.location.protocol === 'https:' &&
        new URL(url).protocol === 'http:'
      if (NO_IFRAME_APPS.has(meta.id) || mixedContent) {
        _kioskFallback(localUrl, { ...meta, remoteOnly: true, remoteUrl: url })
      } else {
        _kioskFallback(localUrl, meta)
      }
      return
    }
    window.location.href = localUrl
    return
  }
  // Use a programmatic anchor click rather than window.open(url, '_blank', 'noopener,noreferrer').
  // window.open with the 'noopener' feature string always returns null in modern browsers,
  // which causes the window.location.href fallback to fire too — double-navigation.
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
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
