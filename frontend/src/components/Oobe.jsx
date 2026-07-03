import { useState, useEffect, useRef } from 'react'
import { Wifi, Lock, Check, X } from 'lucide-react'
import { getWifiStatus, scanWifiNetworks, connectWifi, completeOobe, setupAccount } from '../api.js'
import { isLocalAccess } from '../utils.js'
import Button from './ui/Button.jsx'
import Badge from './ui/Badge.jsx'
import SignalBars from './ui/SignalBars.jsx'
import PasswordField from './ui/PasswordField.jsx'
import PinPad, { PinDots } from './ui/PinPad.jsx'
import Spinner from './ui/Spinner.jsx'
import NimbusMark from './ui/NimbusMark.jsx'

const STATUS_IP_RETRY_DELAY_MS = 1500
const STEP_ORDER = ['network', 'account', 'pin']

function StepDots({ current }) {
  const index = STEP_ORDER.indexOf(current)
  return (
    <div style={s.stepDots}>
      {STEP_ORDER.map((step, i) => (
        <span key={step} style={{ ...s.stepDot, ...(i <= index ? s.stepDotDone : {}) }} />
      ))}
    </div>
  )
}

function NetworkStep({ online, onNext, reconnect }) {
  const [wifiStatus, setWifiStatus] = useState(null)
  const [networks, setNetworks] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [connecting, setConnecting] = useState(null)
  const [passwordSsid, setPasswordSsid] = useState(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [transitioningSsid, setTransitioningSsid] = useState(null)
  // When the OOBE is being served over the onboarding hotspot (this device's
  // own AP), connecting to Wi-Fi tears that hotspot down — which closes the
  // phone's captive-portal sign-in window. Show the "where to go next"
  // instructions and require acknowledgement *before* starting the handover,
  // since the post-connect screen would vanish with the window.
  const [pendingHandover, setPendingHandover] = useState(null) // { ssid, password }
  const pwInputRef = useRef(null)

  useEffect(() => {
    getWifiStatus().then(setWifiStatus).catch(() => {})
  }, [online])

  // The parent `online` prop comes from NetworkManager's global connectivity
  // state, which only flips to "online" once NM's connectivity check passes —
  // that can stay stuck at connected-local on networks that block the check,
  // even when Wi-Fi is associated and has a DHCP lease. Treat a local Wi-Fi
  // association with an IP address as good enough to proceed through onboarding.
  const connected = online || !!(wifiStatus?.connected && wifiStatus?.ip_address)

  // When the user returns to nimbus.local after the device joined Wi-Fi (AP gone,
  // device already online), skip the network step automatically — they obviously
  // have connectivity or they couldn't have loaded this page.
  useEffect(() => {
    if (!isLocalAccess() && wifiStatus && !wifiStatus.ap_active && connected) {
      onNext()
    }
  }, [wifiStatus, connected])

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

  // Decide how to act on a "Connect" tap. Secured, unknown networks need a
  // password first. When the OOBE is served over the onboarding hotspot, the
  // actual connection is a handover that closes this window, so route through
  // the acknowledgement screen instead of connecting immediately.
  function requestConnect(ssid, pwd) {
    const overHotspot = !isLocalAccess() && wifiStatus?.ap_active
    if (overHotspot) {
      setPendingHandover({ ssid, password: pwd || null })
      return
    }
    handleConnect(ssid, pwd)
  }

  async function handleConnect(ssid, pwd) {
    setPendingHandover(null)
    setConnecting(ssid)
    setError(null)
    try {
      // connectWifi resolves only once NetworkManager reports the connection
      // fully activated (associated + DHCP lease), so status is ready now.
      const res = await connectWifi(ssid, pwd || null)
      if (res?.status === 'transitioning') {
        setTransitioningSsid(ssid)
        // The onboarding hotspot is stopping and the device is connecting to
        // WiFi in the background. Poll until the connection is confirmed so the
        // kiosk display can advance without user intervention.
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000))
          try {
            const st = await getWifiStatus()
            if (st?.connected) {
              setTransitioningSsid(null)
              setWifiStatus(st)
              setPasswordSsid(null)
              setPassword('')
              return
            }
          } catch { /* backend may be briefly unreachable while NM reconnects */ }
        }
        return
      }
      setPasswordSsid(null)
      setPassword('')
      await refreshWifiStatus()
      try { setNetworks(await scanWifiNetworks()) } catch {}
    } catch (e) { setError(e.message) }
    finally { setConnecting(null) }
  }

  function promptForPassword(ssid) {
    setPasswordSsid(ssid)
    setPassword('')
    setError(null)
  }

  function cancelPassword() {
    setPasswordSsid(null)
    setPassword('')
  }

  const wifiAvailable = wifiStatus?.available !== false

  if (pendingHandover) {
    const { ssid, password: pwd } = pendingHandover
    return (
      <div style={s.transitionContainer}>
        <h1 style={s.heading}>Almost there</h1>
        <p style={s.subheading}>
          Nimbus will join <strong>{ssid}</strong> and switch off its setup Wi-Fi.
          This page will close on its own — that's expected.
        </p>
        <div style={s.illustrationCard}>
          <div style={s.handoverIcon}>📶→🏠</div>
          <div style={s.instructionStep}>
            <strong>1.</strong> Reconnect this phone to <strong>{ssid}</strong> (or any
            network with internet).
          </div>
          <div style={s.instructionStep}>
            <strong>2.</strong> Open <a href="http://nimbus.local" style={s.link}>nimbus.local</a> in
            your browser to finish setup.
          </div>
        </div>
        <Button variant="primary" fullWidth onClick={() => handleConnect(ssid, pwd)} style={{ marginBottom: 10 }}>
          Connect &amp; continue
        </Button>
        <Button variant="ghost" fullWidth onClick={() => setPendingHandover(null)}>Cancel</Button>
      </div>
    )
  }

  if (transitioningSsid) {
    return (
      <div style={s.transitionContainer}>
        <h1 style={s.heading}>Connecting…</h1>
        <p style={s.subheading}>
          Joining <strong>{transitioningSsid}</strong> and turning off the setup Wi-Fi.
        </p>
        <div style={s.illustrationCard}>
          <div style={s.spinnerContainer}><Spinner size={36} thickness={3} /></div>
          <div style={s.instructionStep}>
            This will continue on its own once Nimbus is online.
          </div>
          {!isLocalAccess() && (
            <div style={s.instructionStep}>
              Still here in a minute? Reconnect to <strong>{transitioningSsid}</strong> and open{' '}
              <a href="http://nimbus.local" style={s.link}>nimbus.local</a>.
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      {!reconnect && <StepDots current="network" />}
      <h1 style={s.heading}>{reconnect ? 'Reconnect to Wi-Fi' : "Let's get you online"}</h1>
      <p style={s.subheading}>
        {connected
          ? "You're connected and ready to continue."
          : reconnect
            ? 'Nimbus lost its connection — reconnect to keep going.'
            : 'Connect Nimbus to your home network to continue setup.'}
      </p>

      <Badge tone={connected ? 'success' : 'danger'} uppercase={false} style={{ marginBottom: 18 }}>
        {connected ? <Check size={13} /> : <X size={13} />}
        <span style={{ marginLeft: 6 }}>
          {connected
            ? `Connected${wifiStatus?.ssid ? ` — ${wifiStatus.ssid}` : ' via Ethernet'}`
            : 'Not connected'}
        </span>
      </Badge>
      {connected && wifiStatus?.ip_address && (
        <div style={s.connectionMeta}>IP address: {wifiStatus.ip_address}</div>
      )}

      {wifiAvailable && passwordSsid && (
        // Dedicated password prompt that replaces the network list. Anchoring it
        // at the top of the panel (instead of expanding inline mid-list) keeps
        // the input and buttons fully visible above the on-screen keyboard in
        // the cramped captive-portal browser, where the list could not scroll.
        <div style={s.wifiPanel}>
          <div style={s.wifiHeader}>
            <span style={s.wifiTitle}><Lock size={13} style={{ marginRight: 6, verticalAlign: -2 }} />{passwordSsid}</span>
          </div>
          <div style={s.pwPrompt}>
            <label style={s.label}>Wi-Fi password</label>
            <PasswordField
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter password"
              onKeyDown={e => e.key === 'Enter' && password && requestConnect(passwordSsid, password)}
              autoFocus
            />
            {error && <div style={{ ...s.netError, padding: '6px 0 0' }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, width: '100%', justifyContent: 'flex-end', marginTop: 12 }}>
              <Button variant="ghost" size="sm" onClick={cancelPassword}>Cancel</Button>
              <Button
                variant="soft"
                size="sm"
                onClick={() => requestConnect(passwordSsid, password)}
                disabled={!password || connecting === passwordSsid}
                loading={connecting === passwordSsid}
              >
                {connecting === passwordSsid ? 'Connecting…' : 'Connect'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {wifiAvailable && !passwordSsid && (
        <div style={s.wifiPanel}>
          <div style={s.wifiHeader}>
            <span style={s.wifiTitle}><Wifi size={14} style={{ marginRight: 6, verticalAlign: -2 }} />Wi-Fi networks</span>
            <Button variant="ghost" size="sm" onClick={handleScan} loading={scanning}>
              {scanning ? 'Scanning…' : 'Scan'}
            </Button>
          </div>
          {error && <div style={s.netError}>{error}</div>}
          {networks === null && <div style={s.netHint}>Tap Scan to find nearby networks</div>}
          {networks?.length === 0 && <div style={s.netHint}>No networks found — try scanning again</div>}
          {networks?.map(net => (
            <div key={net.ssid} style={s.netRow}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                <SignalBars strength={net.strength} />
                <span style={{ ...s.netName, ...(net.in_use ? s.netNameActive : {}) }}>
                  {net.ssid}
                  {net.secured && <Lock size={11} style={{ marginLeft: 5, opacity: 0.5, verticalAlign: -1 }} />}
                  {net.in_use && <Check size={12} style={{ marginLeft: 6, color: 'var(--color-success)', verticalAlign: -1 }} />}
                </span>
              </div>
              {!net.in_use && (
                <Button
                  variant="soft"
                  size="sm"
                  onClick={() => (!net.secured || net.known) ? requestConnect(net.ssid, null) : promptForPassword(net.ssid)}
                  disabled={connecting === net.ssid}
                  loading={connecting === net.ssid}
                >
                  {connecting === net.ssid ? 'Connecting…' : 'Connect'}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <Button variant="primary" fullWidth onClick={onNext} disabled={!connected} style={{ marginBottom: 10 }}>
        {reconnect ? 'Continue' : 'Next'}
      </Button>
      {!connected && (
        <Button variant="ghost" fullWidth onClick={onNext}>Skip — I'm using Ethernet</Button>
      )}
    </>
  )
}

function AccountStep({ onNext }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
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
      onNext()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <>
      <StepDots current="account" />
      <h1 style={s.heading}>Create your account</h1>
      <p style={s.subheading}>
        This protects access to your Nimbus.
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
        <PasswordField
          id="nimbus-pw"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          autoComplete="new-password"
          onKeyDown={e => e.key === 'Enter' && document.getElementById('nimbus-confirm')?.focus()}
        />
        {password.length > 0 && !pwValid && (
          <div style={s.fieldHint}>Password must be at least 8 characters</div>
        )}
      </div>

      <div style={s.fieldGroup}>
        <label style={s.label}>Confirm password</label>
        <PasswordField
          id="nimbus-confirm"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          placeholder="Re-enter password"
          inputStyle={confirm.length > 0 && !pwMatch ? { borderColor: 'var(--color-danger)' } : {}}
          autoComplete="new-password"
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
        />
        {confirm.length > 0 && !pwMatch && (
          <div style={s.fieldHint}>Passwords do not match</div>
        )}
      </div>

      {error && <div style={s.errorBox}>{error}</div>}

      <Button variant="primary" fullWidth onClick={handleSubmit} disabled={!canSubmit} loading={busy}>
        {busy ? 'Creating account…' : 'Next'}
      </Button>
    </>
  )
}

const OOBE_PIN_LENGTH = 4

function PinStep({ onComplete }) {
  const [mode, setMode] = useState('set') // set | confirm
  const [pin, setPin] = useState('')
  const [firstPin, setFirstPin] = useState('')
  const [error, setError] = useState(null)

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
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}>
        <Badge tone="neutral">Optional</Badge>
      </div>
      <h1 style={{ ...s.heading, textAlign: 'center' }}>Add a screen lock PIN</h1>
      <p style={{ ...s.subheading, textAlign: 'center' }}>
        Choose a 4-digit PIN to lock the screen after inactivity. You can add this anytime in Settings instead.
      </p>

      {error && <div style={{ ...s.errorBox, marginBottom: 12 }}>{error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>
          {mode === 'set' ? 'Enter a 4-digit PIN' : 'Confirm your PIN'}
        </div>
        <PinDots length={OOBE_PIN_LENGTH} value={pin} />
        <PinPad value={pin} onChange={setPin} length={OOBE_PIN_LENGTH} onComplete={advance} size={64} />
      </div>

      <Button variant="ghost" fullWidth onClick={onComplete}>Skip for now</Button>
    </>
  )
}

export default function Oobe({ online, onComplete, networkOnly }) {
  const [step, setStep] = useState('network')

  async function finishOobe() {
    try { await completeOobe() } catch {}
    onComplete()
  }

  return (
    <div style={{ ...s.overlay, alignItems: isLocalAccess() ? 'center' : 'flex-start' }}>
      <div className="oobe-card" style={s.card}>
        <div style={s.logoRow}>
          <NimbusMark size={30} />
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
            : <PinStep onComplete={finishOobe} />}
      </div>
      <style>{`
        @keyframes fadeIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
        @media (max-width: 480px) {
          .oobe-card {
            padding: 24px 20px 20px !important;
            border-radius: 20px !important;
          }
        }
      `}</style>
    </div>
  )
}

const s = {
  overlay: {
    position: 'fixed', inset: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
    overflowY: 'auto',
    background: 'linear-gradient(160deg, var(--nimbus-charcoal-950) 0%, var(--nimbus-charcoal-900) 55%, var(--nimbus-charcoal-800) 100%)',
    zIndex: 9999, padding: 20,
    fontFamily: 'var(--font-sans)',
  },
  card: {
    width: 'min(520px,100%)', background: 'var(--color-surface-2)',
    border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-2xl)',
    padding: '36px 32px 28px', boxShadow: 'var(--shadow-xl)',
    backdropFilter: 'blur(var(--blur-lg))', animation: 'fadeIn 0.4s ease',
    display: 'flex', flexDirection: 'column',
  },
  logoRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 },
  logoText: { fontSize: 17, fontWeight: 'var(--font-weight-bold)', color: 'var(--text-primary)', letterSpacing: '-0.02em' },
  stepDots: { display: 'flex', gap: 6, marginBottom: 14 },
  stepDot: { width: 20, height: 4, borderRadius: 2, background: 'var(--color-border-strong)' },
  stepDotDone: { background: 'var(--color-accent)' },
  heading: { margin: '0 0 8px', fontSize: 26, fontWeight: 'var(--font-weight-bold)', color: 'var(--text-primary)', letterSpacing: '-0.02em', lineHeight: 1.15 },
  subheading: { margin: '0 0 18px', fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.5 },
  connectionMeta: { margin: '-10px 0 18px', fontSize: 12, color: 'var(--text-tertiary)' },
  wifiPanel: {
    background: 'var(--color-surface-1)', border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-lg)', overflow: 'hidden', marginBottom: 20,
  },
  wifiHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '11px 14px', borderBottom: '1px solid var(--color-border-subtle)',
    background: 'var(--color-surface-2)',
  },
  wifiTitle: { fontSize: 13, fontWeight: 'var(--font-weight-bold)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' },
  netHint: { padding: '14px', fontSize: 12, color: 'var(--text-tertiary)' },
  netError: { padding: '8px 14px', fontSize: 12, color: 'var(--color-danger)' },
  netRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '13px 14px', borderBottom: '1px solid var(--color-border-subtle)', minHeight: 44,
  },
  netName: { fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  netNameActive: { color: 'var(--color-info-soft-text)' },
  pwPrompt: {
    display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6,
    padding: 14,
  },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 },
  label: { fontSize: 12, fontWeight: 'var(--font-weight-bold)', color: 'var(--text-secondary)', letterSpacing: '0.02em' },
  fieldHint: { fontSize: 11, color: 'var(--color-danger)', marginTop: 2 },
  errorBox: {
    background: 'var(--color-danger-soft-bg)', border: '1px solid var(--color-danger-soft-border)',
    borderRadius: 'var(--radius-sm)', padding: '10px 12px', fontSize: 13,
    color: 'var(--color-danger-soft-text)', marginBottom: 14,
  },
  input: {
    width: '100%', minHeight: 44, background: 'var(--color-surface-2)', border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-sm)', padding: '10px 14px', color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)', fontSize: 14, outline: 'none', boxSizing: 'border-box',
  },
  transitionContainer: {
    display: 'flex', flexDirection: 'column', gap: 8, animation: 'fadeIn 0.4s ease',
  },
  illustrationCard: {
    background: 'var(--color-surface-1)', border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-lg)', padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 16,
    marginTop: 10, alignItems: 'center', textAlign: 'center',
  },
  handoverIcon: { fontSize: 36, lineHeight: 1 },
  spinnerContainer: {
    display: 'flex', justifyContent: 'center', margin: '4px 0 8px',
  },
  instructionStep: {
    fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, textAlign: 'left', alignSelf: 'stretch',
  },
  link: {
    color: 'var(--color-accent-soft-text)', textDecoration: 'underline', fontWeight: 600,
  },
}
