const TONES = {
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
  info: 'var(--color-info)',
  neutral: 'var(--text-tertiary)',
}

export default function StatusDot({ tone = 'neutral', label, size = 8 }) {
  const color = TONES[tone] || TONES.neutral
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {label && (
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
          {label}
        </span>
      )}
    </span>
  )
}
