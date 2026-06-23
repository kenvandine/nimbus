import { useState, useEffect } from 'react'
import { getWifiStatus, scanWifiNetworks, connectWifi, completeOobe, setupAccount } from '../api.js'

const STATUS_IP_RETRY_DELAY_MS = 1500

function SignalBars({ strength }) {
  const bars = 4
  const filled = Math.ceil((strength / 100) * bars)
  return (
    <span style={{ display: 'inline-flex', gap: '2px', alignItems: 'flex-end', height: '14px' }}>
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} style={{
          width: '3px',
          height: `${5 + i * 3}px`,
          borderRadius: '1px',
          background: i < filled ? 'rgba(129,212,250,0.85)' : 'rgba(255,255,255,0.15)',
        }} />
      ))}
    </span>
  )
}

function NetworkStep({ online, onNext, reconnect }) {
  const [wifiStatus, setWifiStatus] = useState(null)
  const [networks, setNetworks] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [connecting, setConnecting] = useState(null)
  const [expandedSsid, setExpandedSsid] = useState(null)
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    getWifiStatus().then(setWifiStatus).catch(() => {})
  }, [online])

  async function refreshWifiStatus() {
    try {
      let nextStatus = await getWifiStatus()
      setWifiStatus(nextStatus)
      if (nextStatus?.connected && !nextStatus.ip_address) {
        await new Promise(resolve => setTimeout(resolve, STATUS_IP_RETRY_DELAY_MS))
        nextStatus = await getWifiStatus()
        setWifiStatus(nextStatus)
      }
    } catch {}
  }

  async function handleScan() {
    setScanning(true)
    setError(null)
    try { setNetworks(await scanWifiNetworks()) }
    catch (e) { setError(e.message) }
    finally { setScanning(false) }
  }

  async function handleConnect(ssid, pwd) {
    setConnecting(ssid)
    setError(null)
    try {
      // connectWifi resolves only once NetworkManager reports the connection
      // fully activated (associated + DHCP lease), so status is ready now.
      await connectWifi(ssid, pwd || null)
      setExpandedSsid(null)
      setPassword('')
      await refreshWifiStatus()
      try { setNetworks(await scanWifiNetworks()) } catch {}
    } catch (e) { setError(e.message) }
    finally { setConnecting(null) }
  }

  function toggleExpand(ssid) {
    setExpandedSsid(p => p === ssid ? null : ssid)
    setPassword('')
    setShowPw(false)
    setError(null)
  }

  const wifiAvailable = wifiStatus?.available !== false

  // The parent `online` prop comes from NetworkManager's global connectivity
  // state, which only flips to "online" once NM's connectivity check passes —
  // that can stay stuck at connected-local on networks that block the check,
  // even when Wi-Fi is associated and has a DHCP lease. Treat a local Wi-Fi
  // association with an IP address as good enough to proceed through onboarding.
  const connected = online || !!(wifiStatus?.connected && wifiStatus?.ip_address)

  return (
    <>
      {!reconnect && <div style={s.stepLabel}>Step 1 of 2</div>}
      <h1 style={s.heading}>{reconnect ? 'Reconnect to a network' : 'Connect to a network'}</h1>
      <p style={s.subheading}>
        {connected
          ? 'Your device is connected and ready to continue.'
          : reconnect
            ? 'Your device lost network connectivity. Connect to Wi-Fi to restore access.'
            : 'Connect your device to the internet to enable setup.'}
      </p>

      <div style={{ ...s.badge, ...(connected ? s.badgeOnline : s.badgeOffline) }}>
        {connected
          ? `✓ Connected${wifiStatus?.ssid ? ` — ${wifiStatus.ssid}` : ' via Ethernet'}`
          : '✗ Not connected'}
      </div>
      {connected && wifiStatus?.ip_address && (
        <div style={s.connectionMeta}>IP address: {wifiStatus.ip_address}</div>
      )}

      {wifiAvailable && (
        <div style={s.wifiPanel}>
          <div style={s.wifiHeader}>
            <span style={s.wifiTitle}>📶 Wi-Fi</span>
            <button
              style={{ ...s.btnSm, ...(scanning ? s.btnSmDisabled : {}) }}
              onClick={handleScan} disabled={scanning}
            >
              {scanning ? 'Scanning…' : 'Scan'}
            </button>
          </div>
          {error && <div style={s.netError}>{error}</div>}
          {networks === null && <div style={s.netHint}>Press Scan to discover available networks</div>}
          {networks?.length === 0 && <div style={s.netHint}>No networks found — try scanning again</div>}
          {networks?.map(net => (
            <div key={net.ssid}>
              <div style={s.netRow}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
                  <SignalBars strength={net.strength} />
                  <span style={{ ...s.netName, ...(net.in_use ? s.netNameActive : {}) }}>
                    {net.ssid}
                    {net.secured && <span style={{ marginLeft: '4px', opacity: 0.5, fontSize: '11px' }}>🔒</span>}
                    {net.in_use && <span style={s.connTag}>✓</span>}
                  </span>
                </div>
                {!net.in_use && (
                  <button
                    style={{ ...s.btnSm, ...(connecting === net.ssid ? s.btnSmDisabled : {}) }}
                    onClick={() => (!net.secured || net.known) ? handleConnect(net.ssid, null) : toggleExpand(net.ssid)}
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
                    <button style={s.eyeBtn} onClick={() => setShowPw(p => !p)} tabIndex={-1}>
                      {showPw ? '🙈' : '👁'}
                    </button>
                  </div>
                  <button
                    style={{ ...s.btnSm, ...(!password || connecting === net.ssid ? s.btnSmDisabled : {}) }}
                    onClick={() => handleConnect(net.ssid, password)}
                    disabled={!password || connecting === net.ssid}
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

      <button
        style={{ ...s.btnPrimary, ...(!connected ? s.btnPrimaryDisabled : {}) }}
        onClick={onNext} disabled={!connected}
      >
        {reconnect ? 'Continue' : 'Next →'}
      </button>
      {!connected && (
        <button style={s.btnGhost} onClick={onNext}>Skip — I'm using Ethernet</button>
      )}
    </>
  )
}

function AccountStep({ onNext }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const pwMatch = password === confirm
  const pwValid = password.length >= 8
  const canSubmit = username.trim().length > 0 && pwValid && pwMatch && !busy

  async function handleSubmit() {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await setupAccount(username.trim(), password)
      await completeOobe()
      onNext()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <>
      <div style={s.stepLabel}>Step 2 of 3</div>
      <h1 style={s.heading}>Create your account</h1>
      <p style={s.subheading}>
        This account protects access to the Nimbus web interface.
      </p>

      <div style={s.fieldGroup}>
        <label style={s.label}>Username</label>
        <input
          type="text"
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder="e.g. admin"
          style={s.input}
          autoFocus
          autoComplete="username"
          onKeyDown={e => e.key === 'Enter' && document.getElementById('nimbus-pw')?.focus()}
        />
      </div>

      <div style={s.fieldGroup}>
        <label style={s.label}>Password</label>
        <div style={{ position: 'relative' }}>
          <input
            id="nimbus-pw"
            type={showPw ? 'text' : 'password'}
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            style={s.input}
            autoComplete="new-password"
            onKeyDown={e => e.key === 'Enter' && document.getElementById('nimbus-confirm')?.focus()}
          />
          <button style={s.eyeBtn} onClick={() => setShowPw(p => !p)} tabIndex={-1}>
            {showPw ? '🙈' : '👁'}
          </button>
        </div>
        {password.length > 0 && !pwValid && (
          <div style={s.fieldHint}>Password must be at least 8 characters</div>
        )}
      </div>

      <div style={s.fieldGroup}>
        <label style={s.label}>Confirm password</label>
        <input
          id="nimbus-confirm"
          type={showPw ? 'text' : 'password'}
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          placeholder="Re-enter password"
          style={{ ...s.input, ...(confirm.length > 0 && !pwMatch ? s.inputError : {}) }}
          autoComplete="new-password"
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
        />
        {confirm.length > 0 && !pwMatch && (
          <div style={s.fieldHint}>Passwords do not match</div>
        )}
      </div>

      {error && <div style={s.errorBox}>{error}</div>}

      <button
        style={{ ...s.btnPrimary, ...(!canSubmit ? s.btnPrimaryDisabled : {}) }}
        onClick={handleSubmit}
        disabled={!canSubmit}
      >
        {busy ? 'Creating account…' : 'Next →'}
      </button>
    </>
  )
}

const OOBE_PIN_LENGTH = 6

function PinStep({ onComplete }) {
  const [mode, setMode] = useState('set') // set | confirm
  const [pin, setPin] = useState('')
  const [firstPin, setFirstPin] = useState('')
  const [error, setError] = useState(null)

  function handleDigit(d) {
    if (pin.length >= OOBE_PIN_LENGTH) return
    const next = pin + d
    setPin(next)
    if (next.length === OOBE_PIN_LENGTH) setTimeout(() => advance(next), 80)
  }

  function advance(entered) {
    if (mode === 'set') {
      setFirstPin(entered); setPin(''); setMode('confirm'); setError(null)
    } else {
      if (entered === firstPin) {
        localStorage.setItem('nimbus_lock_pin', entered)
        onComplete()
      } else {
        setError('PINs did not match — try again'); setPin(''); setMode('set'); setFirstPin('')
      }
    }
  }

  return (
    <>
      <div style={s.stepLabel}>Step 3 of 3 — Optional</div>
      <h1 style={s.heading}>Set a screen lock PIN</h1>
      <p style={s.subheading}>
        Choose a 6-digit PIN to lock the screen after inactivity. You can skip this and set it later in Settings.
      </p>

      {error && <div style={{ ...s.errorBox, marginBottom: 12 }}>{error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
          {mode === 'set' ? 'Enter a 6-digit PIN' : 'Confirm your PIN'}
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          {Array.from({ length: OOBE_PIN_LENGTH }, (_, i) => (
            <div key={i} style={{
              width: 14, height: 14, borderRadius: '50%',
              background: i < pin.length ? 'rgba(79,195,247,0.9)' : 'transparent',
              border: '2px solid ' + (i < pin.length ? 'rgba(79,195,247,0.9)' : 'rgba(255,255,255,0.3)'),
              transition: 'background 0.12s',
            }} />
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((d, i) => (
            <button key={i}
              style={{
                width: 68, height: 68, borderRadius: '50%',
                background: d === '' ? 'transparent' : 'rgba(255,255,255,0.08)',
                border: d === '' ? 'none' : '1px solid rgba(255,255,255,0.12)',
                color: 'rgba(255,255,255,0.85)', fontSize: 22, fontWeight: 400,
                cursor: d === '' ? 'default' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
              onClick={() => d === '⌫' ? setPin(p => p.slice(0, -1)) : d ? handleDigit(d) : undefined}
              disabled={d === ''}
            >{d}</button>
          ))}
        </div>
      </div>

      <button style={s.btnGhost} onClick={onComplete}>Skip — set up later in Settings</button>
    </>
  )
}

export default function Oobe({ online, onComplete, networkOnly }) {
  const [step, setStep] = useState('network')

  return (
    <div style={s.overlay}>
      <div style={s.card}>
        <div style={s.logoRow}>
          <span style={s.logoIcon}>☁</span>
          <span style={s.logoText}>Nimbus</span>
        </div>

        {step === 'network'
          ? <NetworkStep
              online={online}
              reconnect={networkOnly}
              onNext={networkOnly ? onComplete : () => setStep('account')}
            />
          : step === 'account'
            ? <AccountStep onNext={() => setStep('pin')} />
            : <PinStep onComplete={onComplete} />}
      </div>
      <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}`}</style>
    </div>
  )
}

const s = {
  overlay: {
    position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'linear-gradient(145deg,hsl(215,75%,8%) 0%,hsl(220,60%,14%) 60%,hsl(200,55%,28%) 100%)',
    zIndex: 9999, padding: '20px',
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
  },
  card: {
    width: 'min(520px,100%)', background: 'rgba(8,16,28,0.72)',
    border: '1px solid rgba(255,255,255,0.12)', borderRadius: '28px',
    padding: '36px 32px 28px', boxShadow: '0 32px 80px rgba(0,0,0,0.4)',
    backdropFilter: 'blur(20px)', animation: 'fadeIn 0.4s ease',
    display: 'flex', flexDirection: 'column', gap: '0',
    maxHeight: '90vh', overflowY: 'auto',
  },
  logoRow: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '22px' },
  logoIcon: { fontSize: '26px' },
  logoText: { fontSize: '17px', fontWeight: 700, color: 'rgba(255,255,255,0.9)', letterSpacing: '-0.02em' },
  stepLabel: { fontSize: '11px', fontWeight: 700, color: 'rgba(79,195,247,0.7)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' },
  heading: { margin: '0 0 8px', fontSize: '28px', fontWeight: 700, color: 'white', letterSpacing: '-0.03em', lineHeight: 1.15 },
  subheading: { margin: '0 0 16px', fontSize: '14px', color: 'rgba(255,255,255,0.5)', lineHeight: 1.5 },
  badge: {
    display: 'inline-flex', alignSelf: 'flex-start', alignItems: 'center',
    padding: '5px 11px', borderRadius: '999px', fontSize: '12px', fontWeight: 600, marginBottom: '18px',
  },
  badgeOnline: { background: 'rgba(129,199,132,0.18)', color: 'rgba(185,246,202,0.95)', border: '1px solid rgba(129,199,132,0.3)' },
  badgeOffline: { background: 'rgba(255,138,128,0.12)', color: 'rgba(255,204,188,0.9)', border: '1px solid rgba(255,138,128,0.25)' },
  connectionMeta: { margin: '-8px 0 18px', fontSize: '12px', color: 'rgba(255,255,255,0.58)' },
  wifiPanel: {
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
    borderRadius: '14px', overflow: 'hidden', marginBottom: '20px',
  },
  wifiHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '11px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)',
    background: 'rgba(255,255,255,0.03)',
  },
  wifiTitle: { fontSize: '13px', fontWeight: 600, color: 'rgba(255,255,255,0.7)' },
  netHint: { padding: '13px 14px', fontSize: '12px', color: 'rgba(255,255,255,0.3)' },
  netError: { padding: '8px 14px', fontSize: '12px', color: 'rgba(255,138,128,0.9)' },
  netRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
    padding: '9px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  netName: { fontSize: '13px', color: 'rgba(255,255,255,0.55)' },
  netNameActive: { color: 'rgba(129,212,250,0.9)' },
  connTag: { marginLeft: '6px', fontSize: '11px', color: 'rgba(129,199,132,0.9)' },
  pwRow: {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '8px 14px 11px', background: 'rgba(255,255,255,0.02)',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' },
  label: { fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.02em' },
  fieldHint: { fontSize: '11px', color: 'rgba(255,138,128,0.8)', marginTop: '2px' },
  errorBox: {
    background: 'rgba(255,138,128,0.1)', border: '1px solid rgba(255,138,128,0.25)',
    borderRadius: '8px', padding: '10px 12px', fontSize: '13px',
    color: 'rgba(255,204,188,0.9)', marginBottom: '14px',
  },
  input: {
    width: '100%', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: '9px', padding: '9px 36px 9px 12px', color: 'rgba(255,255,255,0.88)',
    fontSize: '13px', outline: 'none', boxSizing: 'border-box',
  },
  inputError: { borderColor: 'rgba(255,138,128,0.5)' },
  eyeBtn: {
    position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
    background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '2px',
  },
  btnSm: {
    background: 'rgba(79,195,247,0.15)', color: 'rgba(79,195,247,0.9)',
    border: '1px solid rgba(79,195,247,0.25)', borderRadius: '7px',
    padding: '5px 12px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  btnSmDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  btnCancel: {
    background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.4)',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: '7px',
    padding: '5px 10px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
  },
  btnPrimary: {
    background: 'rgba(79,195,247,0.22)', color: 'rgba(79,195,247,0.98)',
    border: '1px solid rgba(79,195,247,0.35)', borderRadius: '12px',
    padding: '13px 20px', fontSize: '15px', fontWeight: 700, cursor: 'pointer',
    width: '100%', marginBottom: '10px', marginTop: '4px',
  },
  btnPrimaryDisabled: { opacity: 0.35, cursor: 'not-allowed' },
  btnGhost: {
    background: 'none', border: 'none', color: 'rgba(255,255,255,0.35)',
    fontSize: '13px', cursor: 'pointer', padding: '4px 0',
    textDecoration: 'underline', textDecorationColor: 'rgba(255,255,255,0.15)',
    width: '100%', textAlign: 'center',
  },
}
