import { useState, useEffect, useRef } from 'react'
import PinPad, { PinDots } from './ui/PinPad.jsx'

const PIN_LENGTH = 4

export default function ScreenLock({ deviceName, onUnlock, onFail }) {
  const [pin, setPin] = useState('')
  const [shake, setShake] = useState(false)
  const [time, setTime] = useState(new Date())
  const wrapRef = useRef(null)

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 10000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    wrapRef.current?.focus()
  }, [])

  function verifyPin(entered) {
    const stored = window.localStorage.getItem('nimbus_lock_pin') || ''
    if (!stored || entered === stored) {
      onUnlock?.()
    } else {
      setShake(true)
      setTimeout(() => { setShake(false); setPin('') }, 500)
      onFail?.()
    }
  }

  function handleKeyDown(e) {
    if (e.key >= '0' && e.key <= '9') {
      setPin(p => (p.length < PIN_LENGTH ? p + e.key : p))
      e.preventDefault()
    } else if (e.key === 'Backspace') {
      setPin(p => p.slice(0, -1))
      e.preventDefault()
    }
  }

  const hour = time.getHours()
  const minute = time.getMinutes().toString().padStart(2, '0')
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour % 12 || 12

  return (
    <div style={styles.overlay} tabIndex={-1} onKeyDown={handleKeyDown} ref={wrapRef}>
      <div style={styles.content}>
        <div style={styles.clock}>{h12}:{minute} <span style={styles.ampm}>{ampm}</span></div>
        <div style={styles.date}>{time.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        {deviceName && <div style={styles.deviceName}>{deviceName}</div>}

        <div style={styles.pinRow}>
          <PinDots length={PIN_LENGTH} value={pin} shake={shake} />
        </div>

        <div style={styles.hint}>Enter PIN to unlock</div>

        <PinPad value={pin} onChange={setPin} length={PIN_LENGTH} onComplete={verifyPin} />
      </div>
    </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 9000,
    background: 'var(--color-overlay-scrim)',
    backdropFilter: 'blur(32px)',
    WebkitBackdropFilter: 'blur(32px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    outline: 'none',
    fontFamily: 'var(--font-sans)',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 16,
    userSelect: 'none',
  },
  clock: {
    fontSize: 72,
    fontWeight: 200,
    color: 'var(--text-primary)',
    letterSpacing: '-2px',
    lineHeight: 1,
  },
  ampm: { fontSize: 32, fontWeight: 300, opacity: 0.6 },
  date: { fontSize: 18, color: 'var(--text-secondary)', fontWeight: 300 },
  deviceName: {
    fontSize: 13,
    color: 'var(--color-accent-soft-text)',
    fontWeight: 500,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
  },
  pinRow: { marginTop: 24 },
  hint: { fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 8 },
}
