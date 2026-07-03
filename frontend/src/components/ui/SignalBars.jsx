// Was a byte-identical duplicate in Oobe.jsx and Settings.jsx.
export default function SignalBars({ strength }) {
  const bars = 4
  const filled = Math.ceil((strength / 100) * bars)
  return (
    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'flex-end', height: 14 }}>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          style={{
            width: 3,
            height: 5 + i * 3,
            borderRadius: 1,
            background: i < filled ? 'var(--color-info)' : 'var(--color-border-strong)',
          }}
        />
      ))}
    </span>
  )
}
