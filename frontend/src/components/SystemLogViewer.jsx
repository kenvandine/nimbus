import { useEffect, useRef, useState } from 'react'

export default function SystemLogViewer({ source }) {
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
    const es = new EventSource(`${base}/system/journal?source=${source}&lines=300`, { withCredentials: true })
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
  }, [source])

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
        <span style={{ ...styles.statusDot, background: connected ? '#4caf50' : '#ef5350' }} />
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
    height: '340px',
    background: '#0d1117',
    borderRadius: '10px',
    overflow: 'hidden',
    border: '1px solid rgba(255,255,255,0.08)',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    background: '#161b22',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    flexShrink: 0,
  },
  statusDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  statusLabel: {
    fontSize: '11px',
    color: 'rgba(255,255,255,0.45)',
    flex: 1,
  },
  clearBtn: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'rgba(255,255,255,0.6)',
    borderRadius: '6px',
    padding: '2px 10px',
    fontSize: '11px',
    cursor: 'pointer',
  },
  log: {
    flex: 1,
    overflowY: 'auto',
    padding: '10px 14px',
    fontFamily: '"SF Mono", "Fira Code", "Consolas", monospace',
    fontSize: '11px',
    lineHeight: 1.6,
    color: '#c9d1d9',
  },
  line: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    margin: 0,
  },
  errorLine: {
    color: '#f47067',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  emptyMsg: {
    color: 'rgba(255,255,255,0.25)',
    fontStyle: 'italic',
    fontSize: '12px',
  },
}
