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
  const dotColor = running ? '#4caf50' : app ? '#ef5350' : '#ffb74d'

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
    background: 'rgba(8,16,28,0.82)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '14px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    backdropFilter: 'blur(18px)',
    overflow: 'hidden',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
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
    color: 'white',
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
    color: 'rgba(255,255,255,0.85)',
    flex: 1,
    textAlign: 'left',
  },
  activeBadge: {
    fontSize: '10px',
    fontWeight: 700,
    padding: '1px 6px',
    borderRadius: '999px',
    background: 'rgba(76,175,80,0.25)',
    color: '#81c784',
    letterSpacing: '0.02em',
  },
  chevron: {
    fontSize: '9px',
    color: 'rgba(255,255,255,0.35)',
  },
  body: {
    padding: '0 10px 10px',
  },
  onlineMsg: {
    fontSize: '11px',
    color: 'rgba(255,255,255,0.6)',
    padding: '4px 2px 2px',
  },
  offlineMsg: {
    fontSize: '11px',
    color: 'rgba(255,255,255,0.4)',
    padding: '4px 2px 2px',
    fontStyle: 'italic',
  },
}
