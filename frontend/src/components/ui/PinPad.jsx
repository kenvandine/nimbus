import { useEffect } from 'react'

// Consolidates the numeric-keypad-plus-dot-indicator pattern duplicated in
// Oobe.jsx's PinStep, ScreenLock.jsx, and Settings.jsx's screen-lock section.
// Controlled: the caller owns `value` and decides what onComplete does
// (verify against a stored PIN, save a new one, etc).
export function PinDots({ length = 4, value = '', shake = false, size = 14 }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: size,
        animation: shake ? 'nimbus-pin-shake 0.4s ease' : undefined,
      }}
    >
      <style>{`@keyframes nimbus-pin-shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}`}</style>
      {Array.from({ length }, (_, i) => (
        <div
          key={i}
          style={{
            width: size,
            height: size,
            borderRadius: '50%',
            border: `2px solid ${i < value.length ? 'var(--color-accent)' : 'var(--color-border-strong)'}`,
            background: i < value.length ? 'var(--color-accent)' : 'transparent',
            transition: 'background var(--duration-fast), border-color var(--duration-fast)',
          }}
        />
      ))}
    </div>
  )
}

export default function PinPad({ value = '', onChange, length = 4, onComplete, size = 72, disabled = false }) {
  useEffect(() => {
    if (value.length === length) onComplete?.(value)
  }, [value, length])

  function digit(d) {
    if (disabled || value.length >= length) return
    onChange(value + d)
  }
  function backspace() {
    if (disabled) return
    onChange(value.slice(0, -1))
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((d, i) => (
        <button
          key={i}
          type="button"
          disabled={d === '' || disabled}
          onClick={() => (d === '⌫' ? backspace() : d ? digit(d) : undefined)}
          style={{
            width: size,
            height: size,
            borderRadius: '50%',
            background: d === '' ? 'transparent' : 'var(--color-surface-2)',
            border: d === '' ? 'none' : '1px solid var(--color-border-subtle)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-sans)',
            fontSize: 24,
            fontWeight: 'var(--font-weight-regular)',
            cursor: d === '' ? 'default' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background var(--duration-fast)',
          }}
        >
          {d}
        </button>
      ))}
    </div>
  )
}
