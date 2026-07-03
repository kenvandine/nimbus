// Promotes Settings.jsx's local SectionWrap/Row helpers to a shared kit
// piece, reused by DeviceInfo.jsx and AppModal.jsx's similarly-shaped
// info tables. `icon` now takes a React node (a lucide icon) instead of
// an emoji string.
export function Panel({ children, style }) {
  return (
    <div
      style={{
        background: 'var(--color-surface-1)',
        border: '1px solid var(--color-border-subtle)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export function SettingsSection({ icon, title, children }) {
  return (
    <Panel>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 16px',
          borderBottom: '1px solid var(--color-border-subtle)',
          background: 'var(--color-surface-2)',
        }}
      >
        {icon && <span style={{ display: 'flex', color: 'var(--text-secondary)' }}>{icon}</span>}
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 'var(--font-weight-bold)',
            color: 'var(--text-primary)',
          }}
        >
          {title}
        </span>
      </div>
      <div>{children}</div>
    </Panel>
  )
}

export function SettingsRow({ label, sub, children }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '12px 16px',
        borderBottom: '1px solid var(--color-border-subtle)',
      }}
    >
      <div>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)' }}>
          {label}
        </div>
        {sub && (
          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>
            {sub}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{children}</div>
    </div>
  )
}
