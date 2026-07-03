import { ArrowLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

// Header for a routed full-screen page — replaces the old "Window" title bar
// for primary navigation destinations (App Store, Files, Device Info,
// Settings, Terminal). A real back affordance instead of click-outside-to-dismiss.
export default function PageHeader({ title, children }) {
  const navigate = useNavigate()
  return (
    <div style={styles.header}>
      <button style={styles.backBtn} onClick={() => navigate('/')} aria-label="Back to home">
        <ArrowLeft size={18} />
      </button>
      <span style={styles.title}>{title}</span>
      <div style={styles.actions}>{children}</div>
    </div>
  )
}

const styles = {
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '0 16px',
    height: 56,
    flexShrink: 0,
    borderBottom: '1px solid var(--color-border-subtle)',
    background: 'var(--color-surface-1)',
    backdropFilter: 'blur(var(--blur-md))',
  },
  backBtn: {
    width: 36,
    height: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--color-surface-3)',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    flexShrink: 0,
  },
  title: {
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--font-size-md)',
    fontWeight: 'var(--font-weight-bold)',
    color: 'var(--text-primary)',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
}
