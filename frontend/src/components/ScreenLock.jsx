import { useState, useEffect, useRef, useCallback } from 'react'

const PIN_LENGTH = 6

export default function ScreenLock({ deviceName, onUnlock, onFail }) {
  const [pin, setPin] = useState('')
  const [shake, setShake] = useState(false)
  const [time, setTime] = useState(new Date())
  const inputRef = useRef(null)

  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 10000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function handleDigit(d) {
    if (pin.length >= PIN_LENGTH) return
    const next = pin + d
    setPin(next)
    if (next.length === PIN_LENGTH) {
      setTimeout(() => verifyPin(next), 80)
    }
  }

  function handleBackspace() {
    setPin(p => p.slice(0, -1))
  }

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
    if (e.key >= '0' && e.key <= '9') handleDigit(e.key)
    else if (e.key === 'Backspace') handleBackspace()
    e.preventDefault()
  }

  const hour = time.getHours()
  const minute = time.getMinutes().toString().padStart(2, '0')
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const h12 = hour % 12 || 12

  return (
    <div style={styles.overlay} tabIndex={-1} onKeyDown={handleKeyDown} ref={inputRef}>
      <div style={styles.content}>
        <div style={styles.clock}>{h12}:{minute} <span style={styles.ampm}>{ampm}</span></div>
        <div style={styles.date}>{time.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        {deviceName && <div style={styles.deviceName}>{deviceName}</div>}

        <div style={{ ...styles.pinRow, ...(shake ? styles.pinShake : {}) }}>
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <div key={i} style={{ ...styles.pinDot, ...(i < pin.length ? styles.pinDotFilled : {}) }} />
          ))}
        </div>

        <div style={styles.hint}>Enter PIN to unlock</div>

        <div style={styles.numpad}>
          {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((d, i) => (
            <button
              key={i}
              style={{ ...styles.numBtn, ...(d === '' ? styles.numBtnEmpty : {}) }}
              onClick={() => d === '⌫' ? handleBackspace() : d ? handleDigit(d) : undefined}
              disabled={d === ''}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 9000,
    background: 'rgba(5,10,20,0.97)',
    backdropFilter: 'blur(32px)',
    WebkitBackdropFilter: 'blur(32px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    outline: 'none',
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
    color: 'rgba(255,255,255,0.92)',
    letterSpacing: '-2px',
    lineHeight: 1,
  },
  ampm: { fontSize: 32, fontWeight: 300, opacity: 0.6 },
  date: { fontSize: 18, color: 'rgba(255,255,255,0.5)', fontWeight: 300 },
  deviceName: { fontSize: 13, color: 'rgba(79,195,247,0.7)', fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase' },
  pinRow: {
    display: 'flex',
    gap: 14,
    marginTop: 24,
    transition: 'transform 0.1s',
  },
  pinShake: { animation: 'shake 0.4s ease' },
  pinDot: {
    width: 14,
    height: 14,
    borderRadius: '50%',
    border: '2px solid rgba(255,255,255,0.35)',
    transition: 'background 0.12s, border-color 0.12s',
  },
  pinDotFilled: {
    background: 'rgba(79,195,247,0.9)',
    borderColor: 'rgba(79,195,247,0.9)',
  },
  hint: { fontSize: 13, color: 'rgba(255,255,255,0.3)', marginBottom: 8 },
  numpad: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 12,
    marginTop: 4,
  },
  numBtn: {
    width: 72,
    height: 72,
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'rgba(255,255,255,0.85)',
    fontSize: 24,
    fontWeight: 400,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background 0.1s',
  },
  numBtnEmpty: { background: 'transparent', border: 'none', cursor: 'default' },
}
