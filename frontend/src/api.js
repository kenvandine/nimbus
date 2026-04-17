const BASE = import.meta.env.VITE_API_BASE ?? '/api'

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options)
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json()
}

export const listApps = () => request('/apps')
export const getApp = (id) => request(`/apps/${id}`)
export const installApp = (id) => request(`/apps/${id}/install`, { method: 'POST' })
export const uninstallApp = (id) => request(`/apps/${id}/uninstall`, { method: 'POST' })
export const getStats = () => request('/system/stats')
export const getActiveInstalls = () => request('/apps/installing/active')
