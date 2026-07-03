// Consolidates the pill-shaped "colored-bg + border + small-caps text"
// pattern duplicated across AppCard (confinement/update badges), App.jsx
// (setup badge), DeviceInfo/AppModal status pills, KioskReadyScreen (ready badge).
const TONES = {
  accent: { bg: 'var(--color-accent-soft-bg)', border: 'var(--color-accent-soft-border)', text: 'var(--color-accent-soft-text)' },
  info: { bg: 'var(--color-info-soft-bg)', border: 'var(--color-info-soft-border)', text: 'var(--color-info-soft-text)' },
  success: { bg: 'var(--color-success-soft-bg)', border: 'var(--color-success-soft-border)', text: 'var(--color-success-soft-text)' },
  warning: { bg: 'var(--color-warning-soft-bg)', border: 'var(--color-warning-soft-border)', text: 'var(--color-warning-soft-text)' },
  danger: { bg: 'var(--color-danger-soft-bg)', border: 'var(--color-danger-soft-border)', text: 'var(--color-danger-soft-text)' },
  neutral: { bg: 'var(--color-surface-3)', border: 'var(--color-border-strong)', text: 'var(--text-secondary)' },
}

export default function Badge({ tone = 'neutral', uppercase = true, children, style }) {
  const t = TONES[tone] || TONES.neutral
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '4px 10px',
        borderRadius: 'var(--radius-full)',
        background: t.bg,
        border: `1px solid ${t.border}`,
        color: t.text,
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--font-size-xs)',
        fontWeight: 'var(--font-weight-bold)',
        letterSpacing: uppercase ? '0.06em' : 'normal',
        textTransform: uppercase ? 'uppercase' : 'none',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  )
}
