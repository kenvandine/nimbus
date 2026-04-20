const BASE = import.meta.env.VITE_API_BASE ?? '/api'

function normalizeErrorMessage(status, text, fallback) {
  try {
    const parsed = JSON.parse(text)
    if (parsed?.detail) return `${status}: ${parsed.detail}`
  } catch {
    // Response was not JSON.
  }
  const trimmed = (text || '').trim()
  return `${status}: ${trimmed || fallback}`
}

async function request(path, options = {}) {
  let res
  try {
    res = await fetch(`${BASE}${path}`, options)
  } catch {
    throw new Error('Backend temporarily unavailable')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(normalizeErrorMessage(res.status, text, res.statusText))
  }
  return res.json()
}

export const listApps = () => request('/apps')
export const getApp = (id) => request(`/apps/${id}`)
export const installApp = (id) => request(`/apps/${id}/install`, { method: 'POST' })
export const uninstallApp = (id) => request(`/apps/${id}/uninstall`, { method: 'POST' })
export const getStats = () => request('/system/stats')
export const getActiveInstalls = () => request('/apps/installing/active')
export const updateApp = (id) => request(`/apps/${id}/update`, { method: 'POST' })
export const restartSystem = () => request('/system/restart', { method: 'POST' })
export const powerOffSystem = () => request('/system/poweroff', { method: 'POST' })
export const updateSystem = () => request('/system/update', { method: 'POST' })
