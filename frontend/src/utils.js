let _kioskFallback = null

// Apps that set X-Frame-Options: DENY / frame-ancestors 'none' — cannot be
// embedded in an iframe regardless of origin.  Open directly instead.
const NO_IFRAME_APPS = new Set(['openclaw'])

export function setKioskFallback(fn) {
  _kioskFallback = fn
}

function isLocalAccess() {
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

export function openApp(url, meta = {}) {
  if (isLocalAccess()) {
    // Rewrite any external IP/hostname to localhost so the request resolves
    // on the device itself.  The LXD proxy listens on 0.0.0.0 so localhost
    // always reaches it; the LAN IP only works from remote clients.
    const localUrl = rewriteToLocalhost(url)
    if (_kioskFallback && !NO_IFRAME_APPS.has(meta.id)) {
      _kioskFallback(localUrl, meta)
      return
    }
    // App blocks iframe embedding (X-Frame-Options: DENY) — open directly.
    const opened = window.open(localUrl, '_blank', 'noopener,noreferrer')
    if (!opened) {
      window.location.href = localUrl
    }
    return
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (!opened) {
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
