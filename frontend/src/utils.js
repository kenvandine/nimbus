/**
 * Open a URL in a new tab when the browser allows it (normal browser),
 * or navigate the current tab when popups are blocked (kiosk mode).
 */
export function openApp(url) {
  const win = window.open(url, '_blank', 'noopener,noreferrer')
  if (!win) {
    window.location.href = url
  }
}
