import { useEffect, useRef, useState } from 'react'
import { getActiveInstalls, listApps, getStats } from './api.js'
import AppStore from './components/AppStore.jsx'
import Installed from './components/Installed.jsx'
import SystemStats from './components/SystemStats.jsx'

const TABS = ['App Store', 'Installed']
const POLL_INTERVAL = 5000

export default function App() {
  const [tab, setTab] = useState('App Store')
  const [apps, setApps] = useState([])
  const [stats, setStats] = useState(null)
  const [activeInstalls, setActiveInstalls] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const intervalRef = useRef(null)

  async function fetchAll() {
    try {
      const [appsData, statsData, active] = await Promise.all([
        listApps(),
        getStats(),
        getActiveInstalls(),
      ])
      setApps(appsData)
      setStats(statsData)
      setActiveInstalls(active)
      setError(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAll()
    intervalRef.current = setInterval(fetchAll, POLL_INTERVAL)
    return () => clearInterval(intervalRef.current)
  }, [])

  // Compute gradient position based on system load + active installs
  const load = stats ? (stats.cpu_pct + stats.mem_pct) / 2 + activeInstalls.length * 10 : 0
  const gradientPos = Math.min(100, load)

  const bgStyle = {
    minHeight: '100vh',
    background: `linear-gradient(
      135deg,
      hsl(${210 - gradientPos * 0.8}, 80%, ${8 + gradientPos * 0.08}%) 0%,
      hsl(${205 - gradientPos * 0.5}, 70%, ${15 + gradientPos * 0.1}%) 50%,
      hsl(${195}, 60%, ${35 + (100 - gradientPos) * 0.2}%) 100%
    )`,
    transition: 'background 2s ease',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    color: 'white',
  }

  return (
    <div style={bgStyle}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.logo}>
          <span style={styles.logoIcon}>☁</span>
          <span style={styles.logoText}>Nimbus</span>
        </div>
        <nav style={styles.nav}>
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{ ...styles.tabBtn, ...(tab === t ? styles.tabActive : {}) }}
            >
              {t}
              {t === 'Installed' && apps.filter(a => a.installed).length > 0 && (
                <span style={styles.badge}>{apps.filter(a => a.installed).length}</span>
              )}
            </button>
          ))}
        </nav>
      </header>

      {/* System stats bar */}
      <SystemStats stats={stats} />

      {/* Main content */}
      <main style={styles.main}>
        {loading && (
          <div style={styles.centered}>
            <div style={styles.loadingText}>Loading app store…</div>
          </div>
        )}
        {error && !loading && (
          <div style={styles.centered}>
            <div style={styles.errorBox}>
              <strong>Could not reach backend</strong>
              <p style={{ margin: '8px 0 0', fontSize: '13px', opacity: 0.7 }}>{error}</p>
              <button style={styles.retryBtn} onClick={fetchAll}>Retry</button>
            </div>
          </div>
        )}
        {!loading && !error && tab === 'App Store' && (
          <AppStore apps={apps} onRefresh={fetchAll} />
        )}
        {!loading && !error && tab === 'Installed' && (
          <Installed apps={apps} onRefresh={fetchAll} />
        )}
      </main>

      {/* Spinner keyframes injected once */}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        body { margin: 0; }
        input::placeholder { color: rgba(255,255,255,0.3); }
        input:focus { border-color: rgba(79,195,247,0.5) !important; box-shadow: 0 0 0 3px rgba(79,195,247,0.15); }
        button:hover:not(:disabled) { filter: brightness(1.15); }
      `}</style>
    </div>
  )
}

const styles = {
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 24px',
    height: '60px',
    background: 'rgba(0,0,0,0.25)',
    backdropFilter: 'blur(12px)',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  logoIcon: {
    fontSize: '24px',
  },
  logoText: {
    fontSize: '18px',
    fontWeight: 700,
    letterSpacing: '-0.5px',
    color: 'white',
  },
  nav: {
    display: 'flex',
    gap: '4px',
  },
  tabBtn: {
    background: 'transparent',
    border: 'none',
    color: 'rgba(255,255,255,0.55)',
    padding: '6px 16px',
    borderRadius: '8px',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    transition: 'background 0.15s, color 0.15s',
  },
  tabActive: {
    background: 'rgba(255,255,255,0.12)',
    color: 'white',
  },
  badge: {
    background: 'rgba(79,195,247,0.8)',
    color: '#0a1628',
    borderRadius: '10px',
    padding: '1px 7px',
    fontSize: '11px',
    fontWeight: 700,
  },
  main: {
    maxWidth: '1200px',
    margin: '0 auto',
    padding: '28px 24px',
  },
  centered: {
    display: 'flex',
    justifyContent: 'center',
    paddingTop: '80px',
  },
  loadingText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: '15px',
  },
  errorBox: {
    background: 'rgba(255,100,100,0.1)',
    border: '1px solid rgba(255,100,100,0.25)',
    borderRadius: '12px',
    padding: '24px 32px',
    textAlign: 'center',
    maxWidth: '400px',
  },
  retryBtn: {
    marginTop: '16px',
    background: 'rgba(255,255,255,0.1)',
    color: 'white',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '8px',
    padding: '8px 20px',
    cursor: 'pointer',
    fontSize: '13px',
  },
}
