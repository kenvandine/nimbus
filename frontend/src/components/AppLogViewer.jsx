import { useEffect, useRef, useState } from 'react'

export default function AppLogViewer({ appId }) {
  const [lines, setLines] = useState([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState(null)
  const bottomRef = useRef(null)
  const autoScrollRef = useRef(true)
  const logRef = useRef(null)

  useEffect(() => {
    setLines([])
    setError(null)
    setConnected(false)
    const base = import.meta.env.VITE_API_BASE ?? '/api'
    const es = new EventSource(`${base}/apps/${encodeURIComponent(appId)}/logs?tail=300`, { withCredentials: true })
    setConnected(true)
    es.onmessage = e => {
      try {
        const data = JSON.parse(e.data)
        if (data.line !== undefined) {
          setLines(prev => [...prev.slice(-1999), data.line])
        } else if (data.error) {
          setError(data.error)
        }
      } catch {}
    }
    es.onerror = () => setConnected(false)
    return () => es.close()
  }, [appId])

  useEffect(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [lines])

  function handleScroll() {
    const el = logRef.current
    if (!el) return
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.toolbar}>
        <span style={{ ...styles.statusDot, background: connected ? 'var(--color-success)' : 'var(--color-danger)' }} />
        <span style={styles.statusLabel}>{connected ? 'Live' : 'Disconnected'}</span>
        <button style={styles.clearBtn} onClick={() => setLines([])}>Clear</button>
      </div>
      <div style={styles.log} ref={logRef} onScroll={handleScroll}>
        {lines.length === 0 && !error && (
          <div style={styles.emptyMsg}>Waiting for log output…</div>
        )}
        {lines.map((line, i) => (
          <div key={i} style={styles.line}>{line}</div>
        ))}
        {error && <div style={styles.errorLine}>Error: {error}</div>}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

const styles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--nimbus-charcoal-950)',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    background: 'var(--nimbus-charcoal-900)',
    borderBottom: '1px solid var(--color-border-subtle)',
    flexShrink: 0,
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  statusLabel: {
    fontFamily: 'var(--font-sans)',
    fontSize: '11px',
    color: 'var(--text-tertiary)',
    flex: 1,
  },
  clearBtn: {
    background: 'var(--color-surface-2)',
    border: '1px solid var(--color-border-subtle)',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-sans)',
    borderRadius: 'var(--radius-sm)',
    padding: '2px 10px',
    fontSize: '11px',
    cursor: 'pointer',
  },
  log: {
    flex: 1,
    overflowY: 'auto',
    padding: '10px 14px',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    lineHeight: 1.6,
    color: 'var(--text-secondary)',
  },
  line: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    margin: 0,
  },
  errorLine: {
    color: 'var(--color-danger)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  emptyMsg: {
    color: 'var(--text-disabled)',
    fontFamily: 'var(--font-sans)',
    fontStyle: 'italic',
    fontSize: '12px',
  },
}
