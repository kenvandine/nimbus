import { useEffect, useRef, useState } from 'react'
import { getActiveInstalls, listApps, getStats, uninstallApp } from './api.js'
import Dock from './components/Dock.jsx'
import Window from './components/Window.jsx'
import AppStore from './components/AppStore.jsx'
import DeviceInfo from './components/DeviceInfo.jsx'
import Settings from './components/Settings.jsx'
import AppModal from './components/AppModal.jsx'

const POLL_INTERVAL = 5000

export default function App() {
  const [apps, setApps] = useState([])
  const [stats, setStats] = useState(null)
  const [activeInstalls, setActiveInstalls] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [openWindow, setOpenWindow] = useState(null) // 'appstore' | 'deviceinfo' | 'settings'
  const [detailApp, setDetailApp] = useState(null)
  const [contextMenu, setContextMenu] = useState(null) // { app, x, y }
  const intervalRef = useRef(null)

  async function fetchAll() {
    try {
      const [appsData, statsData, active] = await Promise.all([
        listApps(), getStats(), getActiveInstalls(),
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

  useEffect(() => {
    if (!contextMenu) return
    function dismiss(e) {
      if (e.type === 'keydown' && e.key !== 'Escape') return
      setContextMenu(null)
    }
    window.addEventListener('click', dismiss)
    window.addEventListener('keydown', dismiss)
    return () => {
      window.removeEventListener('click', dismiss)
      window.removeEventListener('keydown', dismiss)
    }
  }, [contextMenu])

  async function handleUninstall(app) {
    setContextMenu(null)
    try {
      await uninstallApp(app.id)
      fetchAll()
    } catch (e) {
      // ignore — card-level errors not applicable here
    }
  }

  // Gradient shifts from stormy (busy) to clear (idle)
  const load = stats ? (stats.cpu_pct + stats.mem_pct) / 2 + activeInstalls.length * 10 : 0
  const hue = 210 - load * 0.6
  const light = 8 + load * 0.06

  const runningApps = apps.filter(a => a.running)
  const updatableCount = apps.filter(a => a.update_available).length

  const n = runningApps.length
  const cols = n === 0 ? 1 : n <= 3 ? n : Math.ceil(Math.sqrt(n))

  return (
    <div style={{ ...styles.desktop, background: `linear-gradient(145deg, hsl(${hue},75%,${light}%) 0%, hsl(${hue + 10},60%,${light + 8}%) 60%, hsl(200,55%,${light + 22}%) 100%)` }}>
      {/* Desktop app icons — running apps */}
      <div style={styles.desktopArea}>
        {loading && <div style={styles.loadingMsg}>Loading…</div>}
        {error && !loading && <div style={styles.errorMsg}>Cannot reach backend — {error}</div>}
        {!loading && !error && (
          <div style={{ ...styles.appGrid, gridTemplateColumns: `repeat(${cols}, 90px)` }}>
            {runningApps.map(app => (
              <DesktopIcon
                key={app.id}
                app={app}
                onClick={() => { if (app.open_url) window.open(app.open_url, '_blank') }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setContextMenu({ app, x: e.clientX, y: e.clientY })
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Dock */}
      <Dock
        onOpen={setOpenWindow}
        updatableCount={updatableCount}
      />

      {/* App windows */}
      {openWindow === 'appstore' && (
        <Window title="App Store" onClose={() => setOpenWindow(null)}>
          <AppStore apps={apps} onRefresh={fetchAll} onOpenDetail={setDetailApp} />
        </Window>
      )}
      {openWindow === 'deviceinfo' && (
        <Window title="Device Info" onClose={() => setOpenWindow(null)}>
          <DeviceInfo stats={stats} apps={apps} />
        </Window>
      )}
      {openWindow === 'settings' && (
        <Window title="Settings" onClose={() => setOpenWindow(null)}>
          <Settings />
        </Window>
      )}

      {/* App detail modal */}
      <AppModal
        app={detailApp}
        onClose={() => setDetailApp(null)}
        onRefresh={() => { fetchAll(); setDetailApp(null) }}
      />

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          style={{ ...styles.ctxMenu, top: contextMenu.y, left: contextMenu.x }}
          onClick={e => e.stopPropagation()}
        >
          {contextMenu.app.open_url && (
            <button style={styles.ctxItem} onClick={() => { window.open(contextMenu.app.open_url, '_blank'); setContextMenu(null) }}>
              Open ↗
            </button>
          )}
          <button style={styles.ctxItem} onClick={() => { setDetailApp(contextMenu.app); setContextMenu(null) }}>
            View Info
          </button>
          <div style={styles.ctxDivider} />
          <button style={{ ...styles.ctxItem, ...styles.ctxItemDanger }} onClick={() => handleUninstall(contextMenu.app)}>
            Uninstall
          </button>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { box-sizing: border-box; }
        body { margin: 0; overflow: hidden; }
        input::placeholder { color: rgba(255,255,255,0.3); }
        input:focus { border-color: rgba(79,195,247,0.5) !important; box-shadow: 0 0 0 3px rgba(79,195,247,0.15); }
        button:hover:not(:disabled) { filter: brightness(1.12); }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 3px; }
      `}</style>
    </div>
  )
}

function DesktopIcon({ app, onClick, onContextMenu }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      style={{ ...styles.desktopIcon, ...(hover ? styles.desktopIconHover : {}) }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <img
        src={app.icon}
        alt=""
        style={styles.desktopIconImg}
        onError={e => { e.target.src = `/api/apps/${app.id}/icon.svg` }}
      />
      {app.update_available && <span style={styles.updateDot} title="Update available" />}
      <span style={styles.desktopIconLabel}>{app.name}</span>
    </div>
  )
}

const styles = {
  desktop: {
    width: '100vw',
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    color: 'white',
    position: 'relative',
    transition: 'background 3s ease',
  },
  desktopArea: {
    flex: 1,
    padding: '24px',
    overflowY: 'auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  appGrid: {
    display: 'grid',
    gap: '8px',
    alignContent: 'flex-start',
  },
  desktopIcon: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '6px',
    padding: '10px 8px 8px',
    borderRadius: '14px',
    cursor: 'pointer',
    width: '90px',
    transition: 'background 0.15s',
    position: 'relative',
  },
  desktopIconHover: {
    background: 'rgba(255,255,255,0.12)',
  },
  desktopIconImg: {
    width: '56px',
    height: '56px',
    borderRadius: '14px',
    objectFit: 'cover',
    filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.4))',
  },
  desktopIconLabel: {
    fontSize: '11px',
    color: 'white',
    textAlign: 'center',
    textShadow: '0 1px 3px rgba(0,0,0,0.7)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '80px',
  },
  updateDot: {
    position: 'absolute',
    top: '8px',
    right: '12px',
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    background: '#ff9800',
    border: '2px solid rgba(0,0,0,0.4)',
  },
  loadingMsg: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: '14px',
    margin: 'auto',
  },
  errorMsg: {
    color: 'rgba(255,150,150,0.8)',
    fontSize: '13px',
    margin: 'auto',
    background: 'rgba(255,0,0,0.1)',
    padding: '12px 20px',
    borderRadius: '10px',
    border: '1px solid rgba(255,100,100,0.2)',
  },
  ctxMenu: {
    position: 'fixed',
    background: 'rgba(18,32,52,0.96)',
    backdropFilter: 'blur(16px)',
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: '12px',
    padding: '6px',
    minWidth: '160px',
    zIndex: 2000,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  },
  ctxItem: {
    display: 'block',
    width: '100%',
    background: 'none',
    border: 'none',
    color: 'rgba(255,255,255,0.85)',
    fontSize: '13px',
    padding: '8px 12px',
    borderRadius: '7px',
    cursor: 'pointer',
    textAlign: 'left',
  },
  ctxItemDanger: {
    color: 'rgba(255,100,100,0.9)',
  },
  ctxDivider: {
    height: '1px',
    background: 'rgba(255,255,255,0.1)',
    margin: '4px 6px',
  },
}
