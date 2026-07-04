import { useState, useEffect, useRef } from 'react'
import { login } from '../api.js'
import Button from './ui/Button.jsx'
import PasswordField from './ui/PasswordField.jsx'
import NimbusMark from './ui/NimbusMark.jsx'
import { useTranslation } from '../i18n.jsx'

// If a login succeeds server-side but the session never takes effect (e.g. the
// parent never flips to authenticated because the cookie didn't stick), this
// component would otherwise hang on "Signing in…" forever. Fall back after a
// few seconds so the user gets feedback instead of a frozen button.
const STUCK_SESSION_TIMEOUT_MS = 6000

export default function Login({ onLogin }) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
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
      setError(t('login_failed', 'Invalid username or password'))
      setBusy(false)
      return
    }
    // Hand off to the parent, which swaps this view out once it sees an
    // authenticated session. Arm a guard in case that never happens.
    clearTimeout(stuckTimer.current)
    stuckTimer.current = setTimeout(() => {
      setBusy(false)
      setError(t('login_session_stuck', 'Signed in, but the session did not persist. Try reloading, or use https:// instead of http://.'))
    }, STUCK_SESSION_TIMEOUT_MS)
    try {
      await onLogin()
    } catch {
      // Parent will re-render based on auth state; the guard covers a hang.
    }
  }

  return (
    <div className="nimbus-dark-scope" style={s.overlay}>
      <div style={s.card}>
        <div style={s.logoRow}>
          <NimbusMark size={30} />
          <span style={s.logoText}>Nimbus</span>
        </div>

        <h1 style={s.heading}>{t('login_welcome_back', 'Welcome back')}</h1>
        <p style={s.subheading}>{t('login_subheading', 'Sign in to open your Nimbus.')}</p>

        <div style={s.fieldGroup}>
          <label style={s.label}>{t('login_username', 'Username')}</label>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder={t('login_username', 'Username')}
            style={s.input}
            autoFocus
            autoComplete="username"
            onKeyDown={e => e.key === 'Enter' && document.getElementById('login-pw')?.focus()}
          />
        </div>

        <div style={s.fieldGroup}>
          <label style={s.label}>{t('login_password', 'Password')}</label>
          <PasswordField
            id="login-pw"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder={t('login_password', 'Password')}
            autoComplete="current-password"
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
          />
        </div>

        {error && <div style={s.errorBox}>{error}</div>}

        <Button variant="primary" fullWidth onClick={handleLogin} disabled={!canSubmit} loading={busy} style={{ marginTop: 6 }}>
          {busy ? t('login_busy', 'Signing in…') : t('login_button', 'Sign in')}
        </Button>
      </div>
      <style>{`@keyframes fadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}`}</style>
    </div>
  )
}

const s = {
  overlay: {
    position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'linear-gradient(160deg, var(--nimbus-charcoal-950) 0%, var(--nimbus-charcoal-900) 55%, var(--nimbus-charcoal-800) 100%)',
    zIndex: 9999, padding: 20,
    fontFamily: 'var(--font-sans)',
  },
  card: {
    width: 'min(400px,100%)', background: 'var(--color-surface-2)',
    border: '1px solid var(--color-border-subtle)', borderRadius: 'var(--radius-2xl)',
    padding: '36px 32px 28px', boxShadow: 'var(--shadow-xl)',
    backdropFilter: 'blur(var(--blur-lg))', animation: 'fadeIn 0.3s ease',
    display: 'flex', flexDirection: 'column',
  },
  logoRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 },
  logoText: { fontSize: 17, fontWeight: 'var(--font-weight-bold)', color: 'var(--text-primary)', letterSpacing: '-0.02em' },
  heading: { margin: '0 0 6px', fontSize: 24, fontWeight: 'var(--font-weight-bold)', color: 'var(--text-primary)', letterSpacing: '-0.02em' },
  subheading: { margin: '0 0 24px', fontSize: 14, color: 'var(--text-tertiary)', lineHeight: 1.5 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 },
  label: { fontSize: 12, fontWeight: 'var(--font-weight-bold)', color: 'var(--text-secondary)', letterSpacing: '0.02em' },
  input: {
    width: '100%', minHeight: 44, background: 'var(--color-surface-2)', border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-sm)', padding: '10px 14px', color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)', fontSize: 14, outline: 'none', boxSizing: 'border-box',
  },
  errorBox: {
    background: 'var(--color-danger-soft-bg)', border: '1px solid var(--color-danger-soft-border)',
    borderRadius: 'var(--radius-sm)', padding: '10px 12px', fontSize: 13,
    color: 'var(--color-danger-soft-text)', marginBottom: 14,
  },
}
