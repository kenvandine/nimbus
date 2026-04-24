import { useState, useEffect } from 'react'

import { restartSystem, updateSystem, getWifiStatus, scanWifiNetworks, connectWifi, disconnectWifi } from '../api.js'

const SECTIONS = [
  {
    title: 'Network',
    icon: '📡',
    items: ['Ethernet', 'Firewall rules', 'DNS settings'],
  },
  {
    title: 'Security',
    icon: '🔒',
    items: ['UI authentication', 'TLS / HTTPS', 'SSH access'],
  },
  {
    title: 'Storage',
    icon: '💾',
    items: ['Disk management', 'Backup configuration', 'App data paths'],
  },
  {
    title: 'About',
    icon: '☁',
    items: ['Nimbus version', 'Licences', 'Source code'],
  },
]

function statusLabel(status) {
  return {
    idle: 'Idle',
    running: 'Updating',
    completed: 'Completed',
    failed: 'Failed',
  }[status || 'idle']
}

function formatTargets(targets) {
  if (!targets?.length) return ''
  const labels = targets.map(target => {
    if (target === 'core24') return 'core24'
    if (target === 'snapd') return 'snapd'
    if (target === 'lxd') return 'LXD'
    if (target.startsWith('nimbus')) return 'Nimbus'
    return target
  })
  if (labels.length === 1) return labels[0]
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`
}

function SignalBars({ strength }) {
  const bars = 4
  const filled = Math.ceil((strength / 100) * bars)
  return (
    <span style={{ display: 'inline-flex', gap: '2px', alignItems: 'flex-end', height: '14px' }}>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          style={{
            width: '3px',
            height: `${5 + i * 3}px`,
            borderRadius: '1px',
            background: i < filled ? 'rgba(129,212,250,0.85)' : 'rgba(255,255,255,0.15)',
          }}
        />
      ))}
    </span>
  )
}

function WifiPanel() {
  const [status, setStatus] = useState(null)
  const [networks, setNetworks] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [connecting, setConnecting] = useState(null)
  const [expandedSsid, setExpandedSsid] = useState(null)
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    getWifiStatus().then(setStatus).catch(() => {})
  }, [])

  async function handleScan() {
    setScanning(true)
    setError(null)
    try {
      const nets = await scanWifiNetworks()
      setNetworks(nets)
    } catch (e) {
      setError(e.message)
    } finally {
      setScanning(false)
    }
  }

  async function handleConnect(ssid, pwd) {
    setConnecting(ssid)
    setError(null)
    try {
      await connectWifi(ssid, pwd || null)
      setExpandedSsid(null)
      setPassword('')
      setTimeout(async () => {
        try { setStatus(await getWifiStatus()) } catch {}
        try { setNetworks(await scanWifiNetworks()) } catch {}
      }, 3000)
    } catch (e) {
      setError(e.message)
    } finally {
      setConnecting(null)
    }
  }

  async function handleDisconnect() {
    setError(null)
    try {
      await disconnectWifi()
      const s = await getWifiStatus()
      setStatus(s)
      if (networks) setNetworks(await scanWifiNetworks())
    } catch (e) {
      setError(e.message)
    }
  }

  function toggleExpand(ssid) {
    setExpandedSsid(prev => prev === ssid ? null : ssid)
    setPassword('')
    setShowPw(false)
    setError(null)
  }

  const unavailable = status && !status.available

  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionIcon}>📶</span>
        <span style={styles.sectionTitle}>Wi-Fi</span>
        <div style={{ marginLeft: 'auto' }}>
          <button
            style={{
              ...styles.btnPrimary,
              ...(scanning ? styles.btnDisabled : {}),
            }}
            onClick={handleScan}
            disabled={scanning || unavailable}
          >
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>
      </div>

      <div style={styles.itemList}>
        {/* Status row */}
        <div style={styles.item}>
          <div>
            <div style={styles.itemLabel}>
              {unavailable
                ? 'Not available'
                : status === null
                  ? 'Loading…'
                  : status.connected
                    ? `Connected to "${status.ssid}"`
                    : 'Not connected'}
            </div>
            {unavailable && status.error && (
              <div style={styles.itemSub}>{status.error}</div>
            )}
          </div>
          {status?.connected && (
            <button style={styles.btnDanger} onClick={handleDisconnect}>
              Disconnect
            </button>
          )}
        </div>

        {error && (
          <div style={{ padding: '8px 16px', color: 'rgba(255,138,128,0.9)', fontSize: '12px' }}>
            {error}
          </div>
        )}

        {/* Network list */}
        {networks !== null && networks.map(net => (
          <div key={net.ssid}>
            <div style={styles.item}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <SignalBars strength={net.strength} />
                <span style={{ ...styles.itemLabel, color: net.in_use ? 'rgba(129,212,250,0.9)' : undefined }}>
                  {net.ssid}
                  {net.secured && <span style={{ marginLeft: '5px', opacity: 0.5 }}>🔒</span>}
                  {net.in_use && <span style={{ marginLeft: '6px', fontSize: '10px', color: 'rgba(129,199,132,0.9)' }}>✓ connected</span>}
                </span>
              </div>
              {!net.in_use && (
                <button
                  style={{
                    ...styles.btnPrimary,
                    ...(connecting === net.ssid ? styles.btnDisabled : {}),
                  }}
                  onClick={() => {
                    if (!net.secured || net.known) {
                      handleConnect(net.ssid, null)
                    } else {
                      toggleExpand(net.ssid)
                    }
                  }}
                  disabled={connecting === net.ssid}
                >
                  {connecting === net.ssid ? 'Connecting…' : 'Connect'}
                </button>
              )}
            </div>

            {expandedSsid === net.ssid && (
              <div style={styles.passwordRow}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <input
                    type={showPw ? 'text' : 'password'}
                    placeholder="Password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleConnect(net.ssid, password)}
                    style={styles.input}
                    autoFocus
                  />
                  <button
                    style={styles.showPwBtn}
                    onClick={() => setShowPw(p => !p)}
                    tabIndex={-1}
                  >
                    {showPw ? '🙈' : '👁'}
                  </button>
                </div>
                <button
                  style={{
                    ...styles.btnPrimary,
                    ...(connecting === net.ssid || !password ? styles.btnDisabled : {}),
                  }}
                  onClick={() => handleConnect(net.ssid, password)}
                  disabled={connecting === net.ssid || !password}
                >
                  {connecting === net.ssid ? 'Connecting…' : 'Connect'}
                </button>
                <button style={styles.btnCancel} onClick={() => setExpandedSsid(null)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        ))}

        {networks !== null && networks.length === 0 && (
          <div style={{ ...styles.item }}>
            <span style={styles.itemLabel}>No networks found</span>
          </div>
        )}

        {networks === null && (
          <div style={{ ...styles.item }}>
            <span style={styles.itemLabel}>Press Scan to discover available networks</span>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Settings({ stats, onRefresh }) {
  const [busyAction, setBusyAction] = useState(null)
  const [localMessage, setLocalMessage] = useState(null)

  const updateSupported = Boolean(stats?.system_update_supported)
  const updateAvailable = Boolean(stats?.system_update_available)
  const powerSupported = Boolean(stats?.device_management_available)
  const updateTargets = stats?.system_update_targets || []
  const updateStatus = stats?.system_update_status || 'idle'
  const updateRunning = updateStatus === 'running'
  const restartRequired = Boolean(stats?.system_restart_required)
  const statusTone = updateStatus === 'failed'
    ? styles.statusPillError
    : updateRunning
      ? styles.statusPillInfo
      : updateAvailable
        ? styles.statusPillInfo
        : styles.statusPillSuccess
  const statusText = updateRunning ? statusLabel(updateStatus) : updateAvailable ? 'Available' : statusLabel(updateStatus)

  async function handleRefresh() {
    setBusyAction('refresh')
    setLocalMessage(null)
    try {
      await updateSystem()
      onRefresh?.()
      setLocalMessage('System update started. Nimbus will update the status automatically.')
    } catch (error) {
      setLocalMessage(error.message)
    } finally {
      setBusyAction(null)
    }
  }

  async function handleRestart() {
    setBusyAction('restart')
    setLocalMessage(null)
    try {
      await restartSystem()
      setLocalMessage('Restart requested. Nimbus will disconnect while the device restarts.')
    } catch (error) {
      setLocalMessage(error.message)
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionIcon}>🔐</span>
          <span style={styles.sectionTitle}>HTTPS Certificate</span>
        </div>
        <div style={styles.itemList}>
          <div style={styles.item}>
            <div>
              <div style={styles.itemLabel}>Trust Nimbus CA</div>
              <div style={styles.itemSub}>Install on each device to remove the HTTPS warning</div>
            </div>
            <a href="/api/system/ca-cert" download="nimbus-ca.crt" style={styles.btnDownload}>
              Download
            </a>
          </div>
          <div style={styles.item}>
            <div style={styles.itemLabel}>iOS / macOS</div>
            <span style={styles.pillInfo}>Download → open → Settings → trust</span>
          </div>
          <div style={styles.item}>
            <div style={styles.itemLabel}>Android</div>
            <span style={styles.pillInfo}>Download → Settings → Security → Install cert</span>
          </div>
          <div style={styles.item}>
            <div style={styles.itemLabel}>Linux</div>
            <span style={styles.pillInfo}>sudo cp nimbus-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates</span>
          </div>
        </div>
      </div>

      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <span style={styles.sectionIcon}>⬆️</span>
          <span style={styles.sectionTitle}>System Updates</span>
        </div>
          <div style={styles.itemList}>
          <div style={styles.item}>
            <div>
              <div style={styles.itemLabel}>Managed snaps</div>
              <div style={styles.itemSub}>
                {stats?.system_update_message
                  || (updateSupported
                    ? updateAvailable
                      ? `Updates are available for ${formatTargets(updateTargets)}.`
                      : 'Nimbus can check for host snap updates and apply them from here.'
                    : 'System updates are available only when Nimbus can access snapd on the host.')}
              </div>
            </div>
            <div style={styles.itemActions}>
              <span style={{ ...styles.statusPill, ...statusTone }}>{statusText}</span>
              <button
                style={{
                  ...styles.btnPrimary,
                  ...((!updateSupported || !updateAvailable || updateRunning || busyAction === 'refresh') ? styles.btnDisabled : {}),
                }}
                onClick={handleRefresh}
                disabled={!updateSupported || !updateAvailable || updateRunning || busyAction === 'refresh'}
              >
                {updateRunning ? 'Updating…' : updateAvailable ? 'Update System' : 'Up to date'}
              </button>
            </div>
          </div>

          {restartRequired && (
            <div style={styles.item}>
              <div>
                <div style={styles.itemLabel}>Restart required</div>
                <div style={styles.itemSub}>The update has finished. Restart the device to apply the new base snap fully.</div>
              </div>
              <button
                style={{
                  ...styles.btnPrimary,
                  ...((!powerSupported || busyAction === 'restart') ? styles.btnDisabled : {}),
                }}
                onClick={handleRestart}
                disabled={!powerSupported || busyAction === 'restart'}
              >
                Restart now
              </button>
            </div>
          )}
        </div>
      </div>

      {localMessage && (
        <div style={styles.notice}>
          <span style={styles.noticeIcon}>{updateStatus === 'failed' ? '⚠️' : 'ℹ️'}</span>
          <div>
            <strong style={{ color: 'white' }}>{updateStatus === 'failed' ? 'Update needs attention' : 'System update status'}</strong>
            <p style={styles.noticeSub}>{localMessage}</p>
          </div>
        </div>
      )}

      <div style={styles.notice}>
        <span style={styles.noticeIcon}>🚧</span>
        <div>
          <strong style={{ color: 'white' }}>More settings coming soon</strong>
          <p style={styles.noticeSub}>Security, storage, and system tuning are still planned for a future release.</p>
        </div>
      </div>

      <WifiPanel />

      {SECTIONS.map(section => (
        <div key={section.title} style={styles.section}>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionIcon}>{section.icon}</span>
            <span style={styles.sectionTitle}>{section.title}</span>
          </div>
          <div style={styles.itemList}>
            {section.items.map(item => (
              <div key={item} style={styles.item}>
                <span style={styles.itemLabel}>{item}</span>
                <span style={styles.pill}>Soon</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', gap: '20px' },
  notice: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    background: 'rgba(255,152,0,0.1)',
    border: '1px solid rgba(255,152,0,0.25)',
    borderRadius: '12px',
    padding: '16px 20px',
    marginBottom: '8px',
  },
  noticeIcon: { fontSize: '24px', flexShrink: 0 },
  noticeSub: { margin: '4px 0 0', color: 'rgba(255,255,255,0.5)', fontSize: '13px' },
  section: {
    background: 'rgba(255,255,255,0.04)',
    borderRadius: '12px',
    overflow: 'hidden',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '12px 16px',
    borderBottom: '1px solid rgba(255,255,255,0.07)',
    background: 'rgba(255,255,255,0.03)',
  },
  sectionIcon: { fontSize: '16px' },
  sectionTitle: { color: 'rgba(255,255,255,0.7)', fontWeight: 600, fontSize: '13px' },
  itemList: {},
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '16px',
    padding: '11px 16px',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  itemActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  itemLabel: { color: 'rgba(255,255,255,0.45)', fontSize: '13px' },
  itemSub: { color: 'rgba(255,255,255,0.3)', fontSize: '11px', marginTop: '2px' },
  btnDownload: {
    background: 'rgba(79,195,247,0.15)',
    color: 'rgba(79,195,247,0.9)',
    border: '1px solid rgba(79,195,247,0.3)',
    borderRadius: '8px',
    padding: '6px 14px',
    fontSize: '12px',
    fontWeight: 600,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
  },
  btnPrimary: {
    background: 'rgba(79,195,247,0.18)',
    color: 'rgba(79,195,247,0.98)',
    border: '1px solid rgba(79,195,247,0.3)',
    borderRadius: '8px',
    padding: '7px 14px',
    fontSize: '12px',
    fontWeight: 700,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  btnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  statusPill: {
    fontSize: '10px',
    fontWeight: 700,
    padding: '4px 8px',
    borderRadius: '999px',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  statusPillInfo: {
    background: 'rgba(79,195,247,0.15)',
    color: 'rgba(129,212,250,0.95)',
  },
  statusPillSuccess: {
    background: 'rgba(129,199,132,0.16)',
    color: 'rgba(185,246,202,0.95)',
  },
  statusPillError: {
    background: 'rgba(255,138,128,0.16)',
    color: 'rgba(255,204,188,0.95)',
  },
  pillInfo: {
    background: 'rgba(255,255,255,0.06)',
    color: 'rgba(255,255,255,0.35)',
    fontSize: '10px',
    fontWeight: 500,
    padding: '3px 8px',
    borderRadius: '6px',
    fontFamily: 'monospace',
    maxWidth: '55%',
    textAlign: 'right',
  },
  pill: {
    background: 'rgba(255,255,255,0.08)',
    color: 'rgba(255,255,255,0.3)',
    fontSize: '10px',
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  btnDanger: {
    background: 'rgba(255,138,128,0.12)',
    color: 'rgba(255,138,128,0.9)',
    border: '1px solid rgba(255,138,128,0.25)',
    borderRadius: '8px',
    padding: '7px 14px',
    fontSize: '12px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  btnCancel: {
    background: 'rgba(255,255,255,0.06)',
    color: 'rgba(255,255,255,0.45)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px',
    padding: '7px 14px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  passwordRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 16px 12px',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    background: 'rgba(255,255,255,0.02)',
  },
  input: {
    width: '100%',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px',
    padding: '7px 36px 7px 12px',
    color: 'rgba(255,255,255,0.85)',
    fontSize: '13px',
    outline: 'none',
    boxSizing: 'border-box',
  },
  showPwBtn: {
    position: 'absolute',
    right: '8px',
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: '14px',
    lineHeight: 1,
    padding: '2px',
  },
}
