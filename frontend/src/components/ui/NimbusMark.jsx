import { useEffect, useState } from 'react'

// Checked once per page load (not once per NimbusMark instance — several are
// mounted across Oobe/Login/KioskReadyScreen) and cached, so an override-free
// install (the common case) does one HEAD request total, not one per mount.
let _overrideChecked = false
let _hasOverride = false
let _checkPromise = null

function checkLogoOverride() {
  if (_checkPromise) return _checkPromise
  _checkPromise = fetch('/theme/logo.svg', { method: 'HEAD' })
    .then(res => { _hasOverride = res.ok; _overrideChecked = true; return _hasOverride })
    .catch(() => { _hasOverride = false; _overrideChecked = true; return false })
  return _checkPromise
}

// The Nimbus logomark — a simple geometric cloud, replacing the previous
// plain-text "☁" emoji used as the in-app logo. Same shape as
// public/favicon.svg, as an inline component so it can be sized/tinted with
// the rest of the UI. An OEM/integrator can replace it entirely by dropping
// a logo.svg into the theme override directory (see backend/main.py);
// falls back to the built-in mark until/unless one is found.
export default function NimbusMark({ size = 28, background = true }) {
  const [hasOverride, setHasOverride] = useState(_hasOverride)

  useEffect(() => {
    if (_overrideChecked) return
    checkLogoOverride().then(setHasOverride)
  }, [])

  if (hasOverride) {
    return (
      <img
        src="/theme/logo.svg"
        alt="Nimbus"
        width={size}
        height={size}
        style={{ display: 'block', borderRadius: background ? '22%' : 0 }}
      />
    )
  }

  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      {background && <rect width="100" height="100" rx="22" fill="var(--nimbus-charcoal-800)" />}
      <path
        d="M32 66c-8 0-14-6-14-13s6-13 13-13c1-9 9-16 19-16 9 0 17 6 19 15 7 1 12 7 12 14 0 8-6 13-14 13H32z"
        fill="var(--color-accent)"
      />
    </svg>
  )
}
