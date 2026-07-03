// Relies on the global `spin` @keyframes defined once in theme.css.
export default function Spinner({ size = 18, color = 'var(--color-accent)', thickness = 2 }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        border: `${thickness}px solid var(--color-border-strong)`,
        borderTopColor: color,
        animation: 'spin 0.7s linear infinite',
        flexShrink: 0,
      }}
    />
  )
}
