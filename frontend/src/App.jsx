import { useEffect, useRef, useState } from 'react'
import { getActiveInstalls, listApps, getStats, powerOffSystem, restartSystem, uninstallApp, getAuthStatus, logout } from './api.js'
import { openApp, setKioskFallback, isLocalAccess } from './utils.js'
import Dock from './components/Dock.jsx'
import Window from './components/Window.jsx'
import AppStore from './components/AppStore.jsx'
import DeviceInfo from './components/DeviceInfo.jsx'
import FileBrowser from './components/FileBrowser.jsx'
import AppLogViewer from './components/AppLogViewer.jsx'
import OpenClawWidget from './components/OpenClawWidget.jsx'
import AppStatusWidget from './components/AppStatusWidget.jsx'
import Settings from './components/Settings.jsx'
import AppModal from './components/AppModal.jsx'
import Oobe from './components/Oobe.jsx'
import Login from './components/Login.jsx'
import KioskReadyScreen from './components/KioskReadyScreen.jsx'

const POLL_INTERVAL = 5000

function RemoteOnlyMessage({ name, remoteUrl }) {
  let nimbuUrl = remoteUrl || ''
  try {
    const { hostname } = new URL(remoteUrl)
    nimbuUrl = `http://${hostname}`
  } catch {}
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 24px' }}>
      <div style={{ maxWidth: 480, textAlign: 'center', color: 'rgba(255,255,255,0.85)' }}>
        <div style={{ fontSize: 48, marginBottom: 20 }}>📱</div>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>{name} requires a remote device</div>
        <div style={{ fontSize: 15, color: 'rgba(255,255,255,0.6)', lineHeight: 1.6, marginBottom: 28 }}>
          This app cannot be displayed on the local screen. Open it on your computer or mobile device connected to the same Wi-Fi network.
        </div>
        <div style={{ background: 'rgba(79,195,247,0.1)', border: '1px solid rgba(79,195,247,0.3)', borderRadius: 12, padding: '14px 20px', fontSize: 18, fontWeight: 700, color: '#81d4fa', letterSpacing: '0.01em' }}>
          {nimbuUrl}
        </div>
      </div>
    </div>
  )
}

function describeSetupState(stats, apps, activeInstalls) {
  if (!stats || stats.control_mode !== 'lxd') return null
  if (stats.bootstrap_error) {
    return {
      title: 'Nimbus setup needs attention',
      message: `The managed LXD container could not be prepared: ${stats.bootstrap_error}`,
      ready: false,
      error: true,
    }
  }
  const lxdReady =
    stats.container_bootstrapped && stats.container_status === 'running' && stats.bootstrap_state === 'ready'
  if (lxdReady) {
    return { ready: true }
  }

  const firstSetup = !stats.container_bootstrapped
  const phaseMessage = firstSetup
    ? {
        idle: 'Preparing the managed environment.',
        'waiting-for-network': 'Waiting for network connectivity before setting up the managed environment.',
        'ensuring-profile': 'Configuring the LXD profile for nested container support.',
        'importing-image': 'Importing pre-built container image.',
        'ensuring-container': 'Creating and starting the managed LXD container.',
        'installing-runtime': 'Installing Docker and required system packages in the managed container.',
        'pushing-agent': 'Copying Nimbus services into the managed container.',
        'installing-agent-python': 'Installing Nimbus Python dependencies in the managed container.',
        'starting-agent': 'Starting Nimbus services in the managed container.',
        ready: 'Finalizing setup.',
      }[stats.bootstrap_state || 'idle'] || 'Preparing the managed environment.'
    : {
        idle: 'Nimbus is checking the managed container and restoring app status.',
        'ensuring-profile': 'Nimbus is checking the managed container configuration.',
        'importing-image': 'Nimbus is importing the pre-built container image.',
        'ensuring-container': 'Nimbus is starting the managed container.',
        'starting-agent': 'Nimbus is starting the managed services.',
        ready: 'Nimbus is finishing startup.',
      }[stats.bootstrap_state || 'idle'] || 'Nimbus is checking the managed container and restoring app status.'

  return {
    title: firstSetup ? 'Nimbus is setting up' : 'Nimbus is starting',
    message: phaseMessage,
    ready: false,
    error: false,
  }
}

export default function App() {
  const [apps, setApps] = useState([])
  const [stats, setStats] = useState(null)
  const [activeInstalls, setActiveInstalls] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [openWindow, setOpenWindow] = useState(null) // 'appstore' | 'deviceinfo' | 'settings'
  const [appFrame, setAppFrame] = useState(null) // { url, name } when showing kiosk iframe
  const [detailApp, setDetailApp] = useState(null)
  const [contextMenu, setContextMenu] = useState(null) // { app, x, y }
  const [powerMenuOpen, setPowerMenuOpen] = useState(false)
  const [powerBusy, setPowerBusy] = useState(null)
  const [systemNotice, setSystemNotice] = useState(null)
  const [logApp, setLogApp] = useState(null) // app whose logs are shown
  const [oobeComplete, setOobeComplete] = useState(true)
  // null = unknown (checking), { configured, authenticated, username } = known
  const [authStatus, setAuthStatus] = useState(null)
  const intervalRef = useRef(null)
  // Set to true when the user explicitly completes OOBE this session so that
  // in-flight poll responses with oobe_complete=false cannot revert the state.
  const oobeCompletedRef = useRef(false)

  async function checkAuth() {
    try {
      const status = await getAuthStatus()
      setAuthStatus(status)
      return status
    } catch {
      // If auth endpoint fails, assume open access
      setAuthStatus({ configured: false, authenticated: true, username: null })
      return null
    }
  }

  async function fetchAll() {
    try {
      const [appsData, statsData, active] = await Promise.all([
        listApps(), getStats(), getActiveInstalls(),
      ])
      setApps(appsData)
      setStats(statsData)
      setActiveInstalls(active)
      setError(null)
      if (statsData.oobe_complete === false && !oobeCompletedRef.current) setOobeComplete(false)
    } catch (e) {
      // A 401 means the session expired — re-check auth status.
      if (e.message.startsWith('401:')) {
        setAuthStatus(prev => prev ? { ...prev, authenticated: false } : null)
        checkAuth()
        return
      }
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleLogout() {
    try { await logout() } catch {}
    setAuthStatus(prev => ({ ...prev, authenticated: false }))
  }

  useEffect(() => {
    setKioskFallback((url, meta) => setAppFrame({ url, name: meta.name || '', remoteOnly: meta.remoteOnly || false, remoteUrl: meta.remoteUrl }))
    checkAuth().then(status => {
      if (!status || status.authenticated) fetchAll()
      else setLoading(false)
    })
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

  useEffect(() => {
    if (!powerMenuOpen) return
    function dismiss(e) {
      if (e.type === 'keydown' && e.key !== 'Escape') return
      setPowerMenuOpen(false)
    }
    window.addEventListener('click', dismiss)
    window.addEventListener('keydown', dismiss)
    return () => {
      window.removeEventListener('click', dismiss)
      window.removeEventListener('keydown', dismiss)
    }
  }, [powerMenuOpen])

  async function handleUninstall(app) {
    setContextMenu(null)
    try {
      await uninstallApp(app.id)
      fetchAll()
    } catch (e) {
      // ignore — card-level errors not applicable here
    }
  }

  async function handlePowerAction(action) {
    setPowerMenuOpen(false)
    setPowerBusy(action)
    try {
      if (action === 'restart') {
        await restartSystem()
        setSystemNotice({
          tone: 'info',
          message: 'Restart requested. Nimbus will disconnect while the device restarts.',
        })
      } else {
        await powerOffSystem()
        setSystemNotice({
          tone: 'info',
          message: 'Power off requested. Nimbus will disconnect while the device shuts down.',
        })
      }
    } catch (e) {
      setSystemNotice({
        tone: 'error',
        message: e.message,
      })
    } finally {
      setPowerBusy(null)
    }
  }

  // Gradient shifts from stormy (busy) to clear (idle)
  const load = stats ? (stats.cpu_pct + stats.mem_pct) / 2 + activeInstalls.length * 10 : 0
  const hue = 210 - load * 0.6
  const light = 8 + load * 0.06

  const runningApps = apps.filter(a => a.running)
  const updatableCount = apps.filter(a => a.update_available).length
  const openclawInstalled = apps.some(a => a.id === 'openclaw' && a.installed)
  const hermesInstalled = apps.some(a => a.id === 'hermes-agent' && a.installed)
  const picoclawInstalled = apps.some(a => a.id === 'picoclaw' && a.installed)

  const n = runningApps.length
  const cols = n === 0 ? 1 : n <= 3 ? n : Math.ceil(Math.sqrt(n))
  const errorMessage = error?.startsWith('Cannot reach backend') ? error : `Cannot reach backend — ${error}`
  const setupState = describeSetupState(stats, apps, activeInstalls)

  const kioskStyle = <style>{`@keyframes spin { to { transform: rotate(360deg); } } * { box-sizing: border-box; } body { margin: 0; overflow: hidden; }`}</style>

  if (isLocalAccess()) {
    if (!oobeComplete) {
      return (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'hsl(215,75%,8%)' }} />
          <Oobe
            online={stats?.online ?? false}
            onComplete={() => {
              oobeCompletedRef.current = true
              setOobeComplete(true)
              checkAuth().then(() => fetchAll())
            }}
          />
          {kioskStyle}
        </>
      )
    }
    const showReconnect = stats !== null && !stats.online
    return (
      <>
        <KioskReadyScreen stats={stats} />
        {showReconnect && (
          <Oobe
            networkOnly
            online={false}
            onComplete={() => fetchAll()}
          />
        )}
        {kioskStyle}
      </>
    )
  }

  return (
    <div style={{ ...styles.desktop, background: `linear-gradient(145deg, hsl(${hue},75%,${light}%) 0%, hsl(${hue + 10},60%,${light + 8}%) 60%, hsl(200,55%,${light + 22}%) 100%)` }}>
      <div style={styles.topBar}>
        {systemNotice && (
          <div style={{ ...styles.systemNotice, ...(systemNotice.tone === 'error' ? styles.systemNoticeError : {}) }}>
            {systemNotice.message}
          </div>
        )}
        {authStatus?.authenticated && authStatus?.configured && (
          <button style={styles.logoutBtn} onClick={handleLogout} title={`Signed in as ${authStatus.username || 'admin'}`}>
            {authStatus.username || 'admin'} · Sign out
          </button>
        )}
        <div style={styles.powerWrap}>
          <button
            style={{
              ...styles.powerButton,
              ...((powerMenuOpen || stats?.system_restart_required) ? styles.powerButtonActive : {}),
              ...((stats && !stats.device_management_available) ? styles.powerButtonDisabled : {}),
            }}
            title={
              stats?.device_management_available === false
                ? 'Power controls are unavailable until Nimbus can access snapd on the host.'
                : 'Power'
            }
            onClick={e => {
              e.stopPropagation()
              setPowerMenuOpen(open => !open)
            }}
            disabled={powerBusy || (stats && !stats.device_management_available)}
          >
            ⏻
          </button>
          {powerMenuOpen && (
            <div style={styles.powerMenu} onClick={e => e.stopPropagation()}>
              <button
                style={styles.powerMenuItem}
                onClick={() => handlePowerAction('restart')}
                disabled={powerBusy}
              >
                Restart
              </button>
              <button
                style={{ ...styles.powerMenuItem, ...styles.powerMenuItemDanger }}
                onClick={() => handlePowerAction('poweroff')}
                disabled={powerBusy}
              >
                Power Off
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Widget stack — bottom left */}
      {(openclawInstalled || hermesInstalled || picoclawInstalled) && (
        <div style={styles.widgetStack}>
          {picoclawInstalled && <AppStatusWidget appId="picoclaw" title="PicoClaw" />}
          {hermesInstalled && <AppStatusWidget appId="hermes-agent" title="Hermes Agent" />}
          {openclawInstalled && <OpenClawWidget />}
        </div>
      )}

      {/* Desktop app icons — running apps */}
      <div style={styles.desktopArea}>
        {loading && <div style={styles.loadingMsg}>Loading…</div>}
        {error && !loading && <div style={styles.errorMsg}>{errorMessage}</div>}
        {!loading && !error && setupState && !setupState.ready && (
          <div style={styles.setupCard}>
            <div style={styles.setupBadge}>{setupState.error ? 'Setup Error' : 'Setup in Progress'}</div>
            <h2 style={styles.setupTitle}>{setupState.title}</h2>
            <p style={styles.setupMessage}>{setupState.message}</p>
            <p style={styles.setupHint}>
              Nimbus will be ready once the managed LXD container is running and fully bootstrapped.
            </p>
          </div>
        )}
        {!loading && !error && (!setupState || setupState.ready) && (
          <div style={{ ...styles.appGrid, gridTemplateColumns: `repeat(${cols}, 90px)` }}>
            {runningApps.map(app => (
              <DesktopIcon
                key={app.id}
                app={app}
                onClick={() => { if (app.open_url) openApp(app.open_url, { name: app.name, id: app.id }) }}
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
        appstoreVisible={stats?.appstore_visible !== false}
      />

      {/* App windows */}
      {openWindow === 'appstore' && (
        <Window title="App Store" onClose={() => setOpenWindow(null)}>
          <AppStore apps={apps} onRefresh={fetchAll} onOpenDetail={setDetailApp} activeInstalls={activeInstalls} />
        </Window>
      )}
      {openWindow === 'files' && (
        <Window title="Files" onClose={() => setOpenWindow(null)} noPad>
          <FileBrowser />
        </Window>
      )}
      {openWindow === 'deviceinfo' && (
        <Window title="Device Info" onClose={() => setOpenWindow(null)}>
          <DeviceInfo stats={stats} apps={apps} />
        </Window>
      )}
      {openWindow === 'settings' && (
        <Window title="Settings" onClose={() => setOpenWindow(null)}>
          <Settings stats={stats} onRefresh={fetchAll} />
        </Window>
      )}

      {/* App log viewer */}
      {logApp && (
        <Window title={`Logs — ${logApp.name}`} onClose={() => setLogApp(null)} noPad>
          <AppLogViewer appId={logApp.id} />
        </Window>
      )}

      {/* App detail modal */}
      <AppModal
        app={detailApp}
        isInstalling={detailApp ? activeInstalls.includes(detailApp.id) : false}
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
            <button style={styles.ctxItem} onClick={() => { openApp(contextMenu.app.open_url, { name: contextMenu.app.name, id: contextMenu.app.id }); setContextMenu(null) }}>
              Open ↗
            </button>
          )}
          {!contextMenu.app.is_system && (
            <button style={styles.ctxItem} onClick={() => { setDetailApp(contextMenu.app); setContextMenu(null) }}>
              View Info
            </button>
          )}
          {!contextMenu.app.is_system && (
            <button style={styles.ctxItem} onClick={() => { setLogApp(contextMenu.app); setContextMenu(null) }}>
              View Logs
            </button>
          )}
          {!contextMenu.app.is_system && (
            <>
              <div style={styles.ctxDivider} />
              <button style={{ ...styles.ctxItem, ...styles.ctxItemDanger }} onClick={() => handleUninstall(contextMenu.app)}>
                Uninstall
              </button>
            </>
          )}
        </div>
      )}

      {!oobeComplete && (
        <Oobe
          online={stats?.online ?? false}
          onComplete={() => {
            oobeCompletedRef.current = true
            setOobeComplete(true)
            checkAuth().then(() => fetchAll())
          }}
        />
      )}

      {oobeComplete && authStatus?.configured && !authStatus?.authenticated && (
        <Login onLogin={() => checkAuth().then(() => fetchAll())} />
      )}

      {appFrame && (
        <div style={styles.frameOverlay}>
          <div style={styles.frameBar}>
            <button style={styles.frameBack} onClick={() => setAppFrame(null)}>← Back to Nimbus</button>
            {appFrame.name && <span style={styles.frameTitle}>{appFrame.name}</span>}
            {!appFrame.remoteOnly && (
              <a href={appFrame.url} target="_blank" rel="noopener noreferrer" style={styles.frameExternal}>
                Open in new tab ↗
              </a>
            )}
          </div>
          {appFrame.remoteOnly ? (
            <RemoteOnlyMessage name={appFrame.name} remoteUrl={appFrame.remoteUrl} />
          ) : (
            <iframe src={appFrame.url} style={styles.frameContent} title={appFrame.name} />
          )}
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
  widgetStack: {
    position: 'fixed',
    bottom: '90px',
    left: '18px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    zIndex: 10,
    alignItems: 'flex-start',
  },
  topBar: {
    position: 'absolute',
    top: '18px',
    right: '24px',
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    zIndex: 20,
  },
  systemNotice: {
    maxWidth: '360px',
    background: 'rgba(8,16,28,0.74)',
    border: '1px solid rgba(79,195,247,0.26)',
    color: 'rgba(255,255,255,0.86)',
    borderRadius: '14px',
    padding: '10px 14px',
    fontSize: '12px',
    lineHeight: 1.45,
    boxShadow: '0 12px 30px rgba(0,0,0,0.22)',
    backdropFilter: 'blur(14px)',
  },
  systemNoticeError: {
    border: '1px solid rgba(255,120,120,0.28)',
    color: 'rgba(255,210,210,0.92)',
  },
  logoutBtn: {
    background: 'rgba(8,16,28,0.54)',
    border: '1px solid rgba(255,255,255,0.14)',
    color: 'rgba(255,255,255,0.55)',
    borderRadius: '12px',
    padding: '0 14px',
    height: '46px',
    fontSize: '12px',
    fontWeight: 500,
    cursor: 'pointer',
    boxShadow: '0 12px 28px rgba(0,0,0,0.2)',
    backdropFilter: 'blur(16px)',
    whiteSpace: 'nowrap',
  },
  powerWrap: {
    position: 'relative',
  },
  powerButton: {
    width: '46px',
    height: '46px',
    borderRadius: '14px',
    border: '1px solid rgba(255,255,255,0.14)',
    background: 'rgba(8,16,28,0.54)',
    color: 'rgba(255,255,255,0.92)',
    fontSize: '22px',
    cursor: 'pointer',
    boxShadow: '0 12px 28px rgba(0,0,0,0.2)',
    backdropFilter: 'blur(16px)',
  },
  powerButtonActive: {
    border: '1px solid rgba(255,152,0,0.45)',
    color: '#ffd180',
  },
  powerButtonDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  powerMenu: {
    position: 'absolute',
    top: '56px',
    right: 0,
    minWidth: '160px',
    background: 'rgba(10,18,30,0.96)',
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: '14px',
    padding: '6px',
    boxShadow: '0 18px 40px rgba(0,0,0,0.36)',
    backdropFilter: 'blur(18px)',
  },
  powerMenuItem: {
    width: '100%',
    border: 'none',
    background: 'transparent',
    color: 'rgba(255,255,255,0.9)',
    padding: '10px 12px',
    borderRadius: '10px',
    fontSize: '13px',
    textAlign: 'left',
    cursor: 'pointer',
  },
  powerMenuItemDanger: {
    color: '#ffb4b4',
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
  setupCard: {
    width: 'min(560px, 100%)',
    background: 'rgba(8,16,28,0.68)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '24px',
    padding: '28px 30px',
    boxShadow: '0 24px 60px rgba(0,0,0,0.28)',
    backdropFilter: 'blur(18px)',
  },
  setupBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '6px 10px',
    borderRadius: '999px',
    background: 'rgba(79,195,247,0.16)',
    color: '#81d4fa',
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    marginBottom: '14px',
  },
  setupTitle: {
    margin: '0 0 10px',
    fontSize: '30px',
    lineHeight: 1.1,
    fontWeight: 700,
  },
  setupMessage: {
    margin: '0 0 12px',
    fontSize: '16px',
    lineHeight: 1.5,
    color: 'rgba(255,255,255,0.88)',
  },
  setupHint: {
    margin: 0,
    fontSize: '13px',
    lineHeight: 1.5,
    color: 'rgba(255,255,255,0.58)',
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
  frameOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 9000,
    display: 'flex',
    flexDirection: 'column',
    background: '#000',
  },
  frameBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '0 16px',
    height: '48px',
    background: 'rgba(8,16,28,0.96)',
    borderBottom: '1px solid rgba(255,255,255,0.1)',
    flexShrink: 0,
  },
  frameBack: {
    background: 'rgba(79,195,247,0.15)',
    border: '1px solid rgba(79,195,247,0.3)',
    color: '#81d4fa',
    borderRadius: '10px',
    padding: '6px 14px',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  frameTitle: {
    fontSize: '14px',
    fontWeight: 600,
    color: 'rgba(255,255,255,0.7)',
    flex: 1,
  },
  frameExternal: {
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.15)',
    color: 'rgba(255,255,255,0.55)',
    borderRadius: '8px',
    padding: '5px 12px',
    fontSize: '12px',
    fontWeight: 500,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  frameContent: {
    flex: 1,
    border: 'none',
    width: '100%',
  },
}
