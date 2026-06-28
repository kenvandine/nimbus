import { useState, useEffect, useRef } from 'react'
import { login } from '../api.js'

// If a login succeeds server-side but the session never takes effect (e.g. the
// parent never flips to authenticated because the cookie didn't stick), this
// component would otherwise hang on "Signing in…" forever. Fall back after a
// few seconds so the user gets feedback instead of a frozen button.
const STUCK_SESSION_TIMEOUT_MS = 6000

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const stuckTimer = useRef(null)

  // On a successful login the parent unmounts this component, which clears the
  // timer below. If we're still mounted when it fires, the session didn't stick.
  useEffect(() => () => clearTimeout(stuckTimer.current), [])

  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy

  async function handleLogin() {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await login(username.trim(), password)
    } catch (e) {
      setError('Invalid username or password')
      setBusy(false)
      return
    }
    // Hand off to the parent, which swaps this view out once it sees an
    // authenticated session. Arm a guard in case that never happens.
    clearTimeout(stuckTimer.current)
    stuckTimer.current = setTimeout(() => {
      setBusy(false)
      setError('Signed in, but the session did not persist. Try reloading, or use https:// instead of http://.')
    }, STUCK_SESSION_TIMEOUT_MS)
    try {
      await onLogin()
    } catch {
      // Parent will re-render based on auth state; the guard covers a hang.
    }
  }

  return (
    <div style={s.overlay}>
      <div style={s.card}>
        <div style={s.logoRow}>
          <span style={s.logoIcon}>☁</span>
          <span style={s.logoText}>Nimbus</span>
        </div>

        <h1 style={s.heading}>Sign in</h1>
        <p style={s.subheading}>Enter your credentials to access the dashboard.</p>

        <div style={s.fieldGroup}>
          <label style={s.label}>Username</label>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="Username"
            style={s.input}
            autoFocus
            autoComplete="username"
            onKeyDown={e => e.key === 'Enter' && document.getElementById('login-pw')?.focus()}
          />
        </div>

        <div style={s.fieldGroup}>
          <label style={s.label}>Password</label>
          <div style={{ position: 'relative' }}>
            <input
              id="login-pw"
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Password"
              style={s.input}
              autoComplete="current-password"
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
            />
            <button style={s.eyeBtn} onClick={() => setShowPw(p => !p)} tabIndex={-1}>
              {showPw ? '🙈' : '👁'}
            </button>
          </div>
        </div>

        {error && <div style={s.errorBox}>{error}</div>}

        <button
          style={{ ...s.btnPrimary, ...(!canSubmit ? s.btnPrimaryDisabled : {}) }}
          onClick={handleLogin}
          disabled={!canSubmit}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
      <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}`}</style>
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
    width: 'min(400px,100%)', background: 'rgba(8,16,28,0.72)',
    border: '1px solid rgba(255,255,255,0.12)', borderRadius: '28px',
    padding: '36px 32px 28px', boxShadow: '0 32px 80px rgba(0,0,0,0.4)',
    backdropFilter: 'blur(20px)', animation: 'fadeIn 0.3s ease',
    display: 'flex', flexDirection: 'column',
  },
  logoRow: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '24px' },
  logoIcon: { fontSize: '26px' },
  logoText: { fontSize: '17px', fontWeight: 700, color: 'rgba(255,255,255,0.9)', letterSpacing: '-0.02em' },
  heading: { margin: '0 0 6px', fontSize: '26px', fontWeight: 700, color: 'white', letterSpacing: '-0.03em' },
  subheading: { margin: '0 0 24px', fontSize: '14px', color: 'rgba(255,255,255,0.45)', lineHeight: 1.5 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '14px' },
  label: { fontSize: '12px', fontWeight: 600, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.02em' },
  input: {
    width: '100%', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: '9px', padding: '10px 36px 10px 12px', color: 'rgba(255,255,255,0.88)',
    fontSize: '14px', outline: 'none', boxSizing: 'border-box',
  },
  eyeBtn: {
    position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
    background: 'none', border: 'none', cursor: 'pointer', fontSize: '15px', lineHeight: 1, padding: '2px',
  },
  errorBox: {
    background: 'rgba(255,138,128,0.1)', border: '1px solid rgba(255,138,128,0.25)',
    borderRadius: '8px', padding: '10px 12px', fontSize: '13px',
    color: 'rgba(255,204,188,0.9)', marginBottom: '14px',
  },
  btnPrimary: {
    background: 'rgba(79,195,247,0.22)', color: 'rgba(79,195,247,0.98)',
    border: '1px solid rgba(79,195,247,0.35)', borderRadius: '12px',
    padding: '13px 20px', fontSize: '15px', fontWeight: 700, cursor: 'pointer',
    width: '100%', marginTop: '6px',
  },
  btnPrimaryDisabled: { opacity: 0.35, cursor: 'not-allowed' },
}
