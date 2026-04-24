import { useState, useEffect } from 'react'
import { getWifiStatus, scanWifiNetworks, connectWifi, completeOobe } from '../api.js'

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

export default function Oobe({ online, onComplete }) {
  const [wifiStatus, setWifiStatus] = useState(null)
  const [networks, setNetworks] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [connecting, setConnecting] = useState(null)
  const [expandedSsid, setExpandedSsid] = useState(null)
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [wifiError, setWifiError] = useState(null)
  const [completing, setCompleting] = useState(false)

  const connected = online

  useEffect(() => {
    getWifiStatus().then(setWifiStatus).catch(() => {})
  }, [online])

  async function handleScan() {
    setScanning(true)
    setWifiError(null)
    try {
      const nets = await scanWifiNetworks()
      setNetworks(nets)
    } catch (e) {
      setWifiError(e.message)
    } finally {
      setScanning(false)
    }
  }

  async function handleConnect(ssid, pwd) {
    setConnecting(ssid)
    setWifiError(null)
    try {
      await connectWifi(ssid, pwd || null)
      setExpandedSsid(null)
      setPassword('')
      setTimeout(async () => {
        try { setWifiStatus(await getWifiStatus()) } catch {}
        try { setNetworks(await scanWifiNetworks()) } catch {}
      }, 3000)
    } catch (e) {
      setWifiError(e.message)
    } finally {
      setConnecting(null)
    }
  }

  async function handleContinue() {
    setCompleting(true)
    try {
      await completeOobe()
      onComplete()
    } catch {
      setCompleting(false)
    }
  }

  function toggleExpand(ssid) {
    setExpandedSsid(prev => prev === ssid ? null : ssid)
    setPassword('')
    setShowPw(false)
    setWifiError(null)
  }

  const wifiAvailable = wifiStatus?.available !== false

  return (
    <div style={s.overlay}>
      <div style={s.card}>
        {/* Header */}
        <div style={s.logoRow}>
          <span style={s.logoIcon}>☁</span>
          <span style={s.logoText}>Nimbus</span>
        </div>
        <h1 style={s.heading}>Welcome to Nimbus</h1>
        <p style={s.subheading}>
          {connected
            ? 'Your device is connected. Ready to continue.'
            : 'Connect your device to the internet to get started.'}
        </p>

        {/* Connectivity status badge */}
        <div style={{ ...s.badge, ...(connected ? s.badgeOnline : s.badgeOffline) }}>
          {connected
            ? `✓ Connected${wifiStatus?.ssid ? ` via Wi-Fi — ${wifiStatus.ssid}` : ' via Ethernet'}`
            : '✗ Not connected'}
        </div>

        {/* Wi-Fi panel (shown when not connected or wifi is available) */}
        {wifiAvailable && (
          <div style={s.wifiPanel}>
            <div style={s.wifiHeader}>
              <span style={s.wifiTitle}>📶 Wi-Fi</span>
              <button
                style={{ ...s.btnSmall, ...(scanning ? s.btnSmallDisabled : {}) }}
                onClick={handleScan}
                disabled={scanning}
              >
                {scanning ? 'Scanning…' : 'Scan'}
              </button>
            </div>

            {wifiError && (
              <div style={s.wifiError}>{wifiError}</div>
            )}

            {networks === null && (
              <div style={s.wifiHint}>Press Scan to discover available networks</div>
            )}

            {networks !== null && networks.length === 0 && (
              <div style={s.wifiHint}>No networks found — try scanning again</div>
            )}

            {networks !== null && networks.map(net => (
              <div key={net.ssid}>
                <div style={s.netRow}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
                    <SignalBars strength={net.strength} />
                    <span style={{ ...s.netName, ...(net.in_use ? s.netNameActive : {}) }}>
                      {net.ssid}
                      {net.secured && <span style={{ marginLeft: '4px', opacity: 0.5, fontSize: '11px' }}>🔒</span>}
                      {net.in_use && <span style={s.connectedTag}>✓</span>}
                    </span>
                  </div>
                  {!net.in_use && (
                    <button
                      style={{ ...s.btnSmall, ...(connecting === net.ssid ? s.btnSmallDisabled : {}) }}
                      onClick={() => {
                        if (!net.secured || net.known) handleConnect(net.ssid, null)
                        else toggleExpand(net.ssid)
                      }}
                      disabled={connecting === net.ssid}
                    >
                      {connecting === net.ssid ? 'Connecting…' : 'Connect'}
                    </button>
                  )}
                </div>

                {expandedSsid === net.ssid && (
                  <div style={s.pwRow}>
                    <div style={{ position: 'relative', flex: 1 }}>
                      <input
                        type={showPw ? 'text' : 'password'}
                        placeholder="Wi-Fi password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && password && handleConnect(net.ssid, password)}
                        style={s.input}
                        autoFocus
                      />
                      <button style={s.showPwBtn} onClick={() => setShowPw(p => !p)} tabIndex={-1}>
                        {showPw ? '🙈' : '👁'}
                      </button>
                    </div>
                    <button
                      style={{ ...s.btnSmall, ...(connecting === net.ssid || !password ? s.btnSmallDisabled : {}) }}
                      onClick={() => handleConnect(net.ssid, password)}
                      disabled={connecting === net.ssid || !password}
                    >
                      {connecting === net.ssid ? 'Connecting…' : 'Connect'}
                    </button>
                    <button style={s.btnCancel} onClick={() => setExpandedSsid(null)}>Cancel</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <button
          style={{ ...s.btnContinue, ...(!connected || completing ? s.btnContinueDisabled : {}) }}
          onClick={handleContinue}
          disabled={!connected || completing}
        >
          {completing ? 'Starting up…' : 'Continue →'}
        </button>

        {!connected && (
          <button style={s.btnSkip} onClick={handleContinue} disabled={completing}>
            Skip — I'm using Ethernet
          </button>
        )}
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  )
}

const s = {
  overlay: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(145deg, hsl(215,75%,8%) 0%, hsl(220,60%,14%) 60%, hsl(200,55%,28%) 100%)',
    zIndex: 9999,
    padding: '20px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  card: {
    width: 'min(520px, 100%)',
    background: 'rgba(8,16,28,0.72)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '28px',
    padding: '36px 32px 28px',
    boxShadow: '0 32px 80px rgba(0,0,0,0.4)',
    backdropFilter: 'blur(20px)',
    animation: 'fadeIn 0.4s ease',
    display: 'flex',
    flexDirection: 'column',
    gap: '0',
  },
  logoRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '20px',
  },
  logoIcon: { fontSize: '28px' },
  logoText: {
    fontSize: '18px',
    fontWeight: 700,
    color: 'rgba(255,255,255,0.9)',
    letterSpacing: '-0.02em',
  },
  heading: {
    margin: '0 0 8px',
    fontSize: '32px',
    fontWeight: 700,
    color: 'white',
    letterSpacing: '-0.03em',
    lineHeight: 1.1,
  },
  subheading: {
    margin: '0 0 18px',
    fontSize: '15px',
    color: 'rgba(255,255,255,0.55)',
    lineHeight: 1.5,
  },
  badge: {
    display: 'inline-flex',
    alignSelf: 'flex-start',
    alignItems: 'center',
    padding: '6px 12px',
    borderRadius: '999px',
    fontSize: '12px',
    fontWeight: 600,
    marginBottom: '20px',
  },
  badgeOnline: {
    background: 'rgba(129,199,132,0.18)',
    color: 'rgba(185,246,202,0.95)',
    border: '1px solid rgba(129,199,132,0.3)',
  },
  badgeOffline: {
    background: 'rgba(255,138,128,0.12)',
    color: 'rgba(255,204,188,0.9)',
    border: '1px solid rgba(255,138,128,0.25)',
  },
  wifiPanel: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.09)',
    borderRadius: '16px',
    overflow: 'hidden',
    marginBottom: '22px',
  },
  wifiHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 14px',
    borderBottom: '1px solid rgba(255,255,255,0.07)',
    background: 'rgba(255,255,255,0.03)',
  },
  wifiTitle: {
    fontSize: '13px',
    fontWeight: 600,
    color: 'rgba(255,255,255,0.7)',
  },
  wifiHint: {
    padding: '14px',
    fontSize: '12px',
    color: 'rgba(255,255,255,0.3)',
  },
  wifiError: {
    padding: '8px 14px',
    fontSize: '12px',
    color: 'rgba(255,138,128,0.9)',
  },
  netRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '10px 14px',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  netName: {
    fontSize: '13px',
    color: 'rgba(255,255,255,0.55)',
  },
  netNameActive: {
    color: 'rgba(129,212,250,0.9)',
  },
  connectedTag: {
    marginLeft: '6px',
    fontSize: '11px',
    color: 'rgba(129,199,132,0.9)',
  },
  pwRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 14px 12px',
    background: 'rgba(255,255,255,0.02)',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  input: {
    width: '100%',
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px',
    padding: '7px 36px 7px 11px',
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
  btnSmall: {
    background: 'rgba(79,195,247,0.15)',
    color: 'rgba(79,195,247,0.9)',
    border: '1px solid rgba(79,195,247,0.25)',
    borderRadius: '7px',
    padding: '5px 12px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnSmallDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  btnCancel: {
    background: 'rgba(255,255,255,0.06)',
    color: 'rgba(255,255,255,0.4)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '7px',
    padding: '5px 10px',
    fontSize: '12px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnContinue: {
    background: 'rgba(79,195,247,0.22)',
    color: 'rgba(79,195,247,0.98)',
    border: '1px solid rgba(79,195,247,0.35)',
    borderRadius: '12px',
    padding: '13px 20px',
    fontSize: '15px',
    fontWeight: 700,
    cursor: 'pointer',
    width: '100%',
    transition: 'opacity 0.15s',
    marginBottom: '10px',
  },
  btnContinueDisabled: {
    opacity: 0.35,
    cursor: 'not-allowed',
  },
  btnSkip: {
    background: 'none',
    border: 'none',
    color: 'rgba(255,255,255,0.35)',
    fontSize: '13px',
    cursor: 'pointer',
    padding: '4px 0',
    textDecoration: 'underline',
    textDecorationColor: 'rgba(255,255,255,0.15)',
    alignSelf: 'center',
    width: '100%',
    textAlign: 'center',
  },
}
