import Spinner from './Spinner.jsx'

// Consolidates the btnPrimary/btnSecondary/btnDanger/btnGhost patterns that
// were previously hand-rolled per-file (AppCard, Oobe, Login, Settings,
// AppModal, DeviceInfo, App.jsx). `primary` is now a solid accent fill
// rather than the old translucent-accent style, for clearer one-glance
// hierarchy; the old "soft accent" look is still available as `soft`.
const VARIANTS = {
  primary: {
    background: 'var(--color-accent)',
    color: 'var(--color-text-on-accent)',
    border: '1px solid transparent',
  },
  soft: {
    background: 'var(--color-accent-soft-bg)',
    color: 'var(--color-accent-soft-text)',
    border: '1px solid var(--color-accent-soft-border)',
  },
  secondary: {
    background: 'var(--color-surface-3)',
    color: 'var(--text-primary)',
    border: '1px solid var(--color-border-strong)',
  },
  danger: {
    background: 'var(--color-danger-soft-bg)',
    color: 'var(--color-danger-soft-text)',
    border: '1px solid var(--color-danger-soft-border)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--text-secondary)',
    border: '1px solid transparent',
  },
}

const SIZES = {
  md: { height: 44, padding: '0 20px', fontSize: 'var(--font-size-md)', gap: 8 },
  sm: { height: 34, padding: '0 14px', fontSize: 'var(--font-size-sm)', gap: 6 },
}

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  fullWidth = false,
  children,
  style,
  ...rest
}) {
  const v = VARIANTS[variant] || VARIANTS.primary
  const s = SIZES[size] || SIZES.md
  const isDisabled = disabled || loading

  return (
    <button
      {...rest}
      disabled={isDisabled}
      type={rest.type ?? 'button'}
      style={{
        ...v,
        height: s.height,
        padding: s.padding,
        fontSize: s.fontSize,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: s.gap,
        width: fullWidth ? '100%' : undefined,
        fontFamily: 'var(--font-sans)',
        fontWeight: 'var(--font-weight-bold)',
        borderRadius: 'var(--radius-sm)',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled ? 0.45 : 1,
        whiteSpace: 'nowrap',
        transition: 'filter var(--duration-fast) var(--ease-standard)',
        ...style,
      }}
    >
      {loading && <Spinner size={s.height * 0.36} color={v.color} thickness={2} />}
      {children}
    </button>
  )
}
