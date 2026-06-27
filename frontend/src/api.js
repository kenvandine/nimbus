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
    res = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...options })
  } catch {
    throw new Error('Backend temporarily unavailable')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(normalizeErrorMessage(res.status, text, res.statusText))
  }
  return res.json()
}

const json = (method, path, body) => request(path, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const listApps = () => request('/apps')
export const getApp = (id) => request(`/apps/${id}`)
export const installApp = (id) => request(`/apps/${id}/install`, { method: 'POST' })
export const uninstallApp = (id) => request(`/apps/${id}/uninstall`, { method: 'POST' })
export const startApp = (id) => request(`/apps/${id}/start`, { method: 'POST' })
export const stopApp = (id) => request(`/apps/${id}/stop`, { method: 'POST' })
export const restartApp = (id) => request(`/apps/${id}/restart`, { method: 'POST' })
export const getStats = () => request('/system/stats')
export const getActiveInstalls = () => request('/apps/installing/active')
export const updateApp = (id) => request(`/apps/${id}/update`, { method: 'POST' })
export const restartSystem = () => request('/system/restart', { method: 'POST' })
export const powerOffSystem = () => request('/system/poweroff', { method: 'POST' })
export const updateSystem = () => request('/system/update', { method: 'POST' })
export const getNetworkAddresses = () => request('/network/addresses')
export const getWifiStatus = () => request('/network/wifi/status')
export const scanWifiNetworks = () => request('/network/wifi/networks')
export const connectWifi = (ssid, password) => json('POST', '/network/wifi/connect', { ssid, password: password || null })
export const disconnectWifi = () => request('/network/wifi/disconnect', { method: 'POST' })
export const completeOobe = () => request('/system/oobe-complete', { method: 'POST' })

export const getAuthStatus = () => request('/auth/status')
export const setupAccount = (username, password) => json('POST', '/auth/setup', { username, password })
export const login = (username, password) => json('POST', '/auth/login', { username, password })
export const logout = () => request('/auth/logout', { method: 'POST' })
export const refreshSession = () => request('/auth/refresh', { method: 'POST' })

// File browser
export const listFiles = (path = '/') => request(`/files/list?path=${encodeURIComponent(path)}`)
export const readFile = (path) => {
  const base = import.meta.env.VITE_API_BASE ?? '/api'
  return fetch(`${base}/files/read?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' })
    .then(res => {
      if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`)
      return res.text()
    })
}
export const writeFile = (path, content) => json('POST', '/files/write', { path, content })

// OpenClaw agent gateway
export const getOpenClawStatus = () => request('/openclaw/status')

// SSH key management
export const getSshStatus = () => request('/ssh/status')
export const listSshKeys = () => request('/ssh/keys')
export const addSshKey = (pubkey) => json('POST', '/ssh/keys', { pubkey })
export const removeSshKey = (fingerprint) => request(`/ssh/keys/${encodeURIComponent(fingerprint)}`, { method: 'DELETE' })

// Firewall
export const getFirewallStatus = () => request('/firewall/status')
export const listFirewallRules = () => request('/firewall/rules')
export const addFirewallRule = (port, proto, action) => json('POST', '/firewall/rules', { port, proto, action })
export const deleteFirewallRule = (number) => request(`/firewall/rules/${number}`, { method: 'DELETE' })
export const enableFirewall = () => request('/firewall/enable', { method: 'POST' })
export const disableFirewall = () => request('/firewall/disable', { method: 'POST' })

// DNS
export const getDns = () => request('/network/dns')
export const setDns = (servers) => json('PUT', '/network/dns', { servers })

// Auth
export const changePassword = (current_password, new_password) =>
  json('POST', '/auth/change-password', { current_password, new_password })

// Resource limits
export const getResourceLimits = () => request('/system/resources')
export const setResourceLimits = (cpu_cores, memory_mb) =>
  json('PUT', '/system/resources', { cpu_cores, memory_mb })

// App update check
export const checkForUpdates = () => request('/apps/check-updates', { method: 'POST' })
export const refreshCatalog = () => request('/apps/refresh-catalog', { method: 'POST' })

// AI Models
export const getModelStatus = () => request('/models/status')
export const getAvailableModels = () => request('/models/available')
export const pullModel = () => request('/models/pull', { method: 'POST' })
export const ensureModel = () => request('/models/ensure', { method: 'POST' })
export const selectModel = (modelName) => json('POST', '/models/select', { model_name: modelName })

// API Keys
export const listApiKeys = () => request('/keys')
export const setApiKey = (name, value) => json('POST', '/keys', { name, value })
export const deleteApiKey = (name) => request(`/keys/${encodeURIComponent(name)}`, { method: 'DELETE' })
