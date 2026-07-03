import { useEffect, useState } from 'react'
import { getApp } from '../api.js'

const POLL_MS = 5000

export default function AppStatusWidget({ appId, title }) {
  const [app, setApp] = useState(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    let alive = true
    async function poll() {
      try {
        const a = await getApp(appId)
        if (alive) setApp(a)
      } catch {}
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [appId])

  const running = app?.running ?? false
  const dotColor = running ? 'var(--color-success)' : app ? 'var(--color-danger)' : 'var(--color-warning)'

  return (
    <div style={styles.widget}>
      <button style={styles.header} onClick={() => setCollapsed(c => !c)}>
        <span style={{ ...styles.dot, background: dotColor }} />
        <span style={styles.title}>{title}</span>
        {running && <span style={styles.activeBadge}>running</span>}
        <span style={styles.chevron}>{collapsed ? '▲' : '▼'}</span>
      </button>

      {!collapsed && (
        <div style={styles.body}>
          {running ? (
            <div style={styles.onlineMsg}>App is running</div>
          ) : app ? (
            <div style={styles.offlineMsg}>App is offline</div>
          ) : (
            <div style={styles.offlineMsg}>Connecting…</div>
          )}
        </div>
      )}
    </div>
  )
}

const styles = {
  widget: {
    width: '220px',
    background: 'var(--color-surface-2)',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-md)',
    boxShadow: 'var(--shadow-md)',
    backdropFilter: 'blur(var(--blur-lg))',
    overflow: 'hidden',
    fontFamily: 'var(--font-sans)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    width: '100%',
    background: 'none',
    border: 'none',
    padding: '10px 12px',
    cursor: 'pointer',
    color: 'var(--text-primary)',
  },
  dot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  title: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--text-primary)',
    flex: 1,
    textAlign: 'left',
  },
  activeBadge: {
    fontSize: '10px',
    fontWeight: 700,
    padding: '1px 6px',
    borderRadius: 'var(--radius-full)',
    background: 'var(--color-success-soft-bg)',
    color: 'var(--color-success-soft-text)',
    letterSpacing: '0.02em',
  },
  chevron: {
    fontSize: '9px',
    color: 'var(--text-tertiary)',
  },
  body: {
    padding: '0 10px 10px',
  },
  onlineMsg: {
    fontSize: '11px',
    color: 'var(--text-secondary)',
    padding: '4px 2px 2px',
  },
  offlineMsg: {
    fontSize: '11px',
    color: 'var(--text-tertiary)',
    padding: '4px 2px 2px',
    fontStyle: 'italic',
  },
}
