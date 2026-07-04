import { useEffect, useRef, useState } from 'react'
import { HashRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { Power } from 'lucide-react'
import { getActiveInstalls, listApps, getStats, powerOffSystem, restartSystem, uninstallApp, startApp, stopApp, restartApp, getAuthStatus, logout, refreshSession } from './api.js'
import { openApp, setKioskFallback, isLocalAccess } from './utils.js'
import { ambientGradient } from './theme.js'
import Dock from './components/Dock.jsx'
import Home from './components/Home.jsx'
import Window from './components/Window.jsx'
import Page from './components/ui/Page.jsx'
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
import TerminalPanel from './components/TerminalPanel.jsx'
import ScreenLock from './components/ScreenLock.jsx'
import { useTranslation } from './i18n.jsx'

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000 // 15 minutes

const POLL_INTERVAL = 5000

const ROUTE_TO_DOCK_ID = { '/app-store': 'appstore', '/files': 'files', '/device-info': 'deviceinfo', '/settings': 'settings', '/terminal': 'terminal' }

function RemoteOnlyMessage({ name, remoteUrl }) {
  const { t } = useTranslation()
  let nimbuUrl = remoteUrl || ''
  try {
    const { hostname } = new URL(remoteUrl)
    nimbuUrl = `http://${hostname}`
  } catch {}
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 24px' }}>
      <div style={{ maxWidth: 480, textAlign: 'center', color: 'var(--text-primary)' }}>
        <div style={{ fontSize: 48, marginBottom: 20 }}>📱</div>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>{t('remote_only_title', '{{name}} requires a remote device', { name })}</div>
        <div style={{ fontSize: 15, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 28 }}>
          {t('remote_only_desc', 'This app cannot be displayed on the local screen. Open it on your computer or mobile device connected to the same Wi-Fi network.')}
        </div>
        <div style={{ background: 'var(--color-accent-soft-bg)', border: '1px solid var(--color-accent-soft-border)', borderRadius: 12, padding: '14px 20px', fontSize: 18, fontWeight: 700, color: 'var(--color-accent-soft-text)', letterSpacing: '0.01em' }}>
          {nimbuUrl}
        </div>
      </div>
    </div>
  )
}

function AppFrameOverlay({ appFrame, onClose }) {
  const { t } = useTranslation()
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'F11') { e.preventDefault(); setFullscreen(f => !f) }
      if (e.key === 'Escape' && fullscreen) setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  return (
    <div style={{ ...styles.frameOverlay, ...(fullscreen ? styles.frameOverlayFull : {}) }}>
      {!fullscreen && (
        <div style={styles.frameBar}>
          <button style={styles.frameBack} onClick={onClose}>{t('frame_back', '← Back to Nimbus')}</button>
          {appFrame.name && <span style={styles.frameTitle}>{appFrame.name}</span>}
          <div style={{ display: 'flex', gap: 8 }}>
            {!appFrame.remoteOnly && (
              <a href={appFrame.url} target="_blank" rel="noopener noreferrer" style={styles.frameExternal}>
                {t('frame_open_tab', 'Open in new tab ↗')}
              </a>
            )}
            {!appFrame.remoteOnly && (
              <button style={styles.frameExternal} onClick={() => setFullscreen(true)}>
                {t('frame_fullscreen', '⛶ Fullscreen')}
              </button>
            )}
          </div>
        </div>
      )}
      {fullscreen && (
        <button style={styles.fullscreenExit} onClick={() => setFullscreen(false)}>
          {t('frame_exit_fullscreen', '✕ Exit fullscreen')}
        </button>
      )}
      {appFrame.remoteOnly ? (
        <RemoteOnlyMessage name={appFrame.name} remoteUrl={appFrame.remoteUrl} />
      ) : (
        <iframe src={appFrame.url} style={styles.frameContent} title={appFrame.name} />
      )}
    </div>
  )
}

function describeSetupState(stats, apps, activeInstalls, t) {
  if (!stats || stats.control_mode !== 'lxd') return null
  if (stats.bootstrap_error) {
    return {
      title: t('setup_attention_title', 'Nimbus setup needs attention'),
      message: t('setup_attention_msg', 'The managed LXD container could not be prepared: {{error}}', { error: stats.bootstrap_error }),
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
        idle: t('setup_phase_idle', 'Preparing the managed environment.'),
        'waiting-for-network': t('setup_phase_waiting_network', 'Waiting for network connectivity before setting up the managed environment.'),
        'ensuring-profile': t('setup_phase_ensuring_profile', 'Configuring the LXD profile for nested container support.'),
        'importing-image': t('setup_phase_importing_image', 'Importing pre-built container image.'),
        'ensuring-container': t('setup_phase_ensuring_container', 'Creating and starting the managed LXD container.'),
        'installing-runtime': t('setup_phase_installing_runtime', 'Installing Docker and required system packages in the managed container.'),
        'pushing-agent': t('setup_phase_pushing_agent', 'Copying Nimbus services into the managed container.'),
        'installing-agent-python': t('setup_phase_installing_python', 'Installing Nimbus Python dependencies in the managed container.'),
        'starting-agent': t('setup_phase_starting_agent', 'Starting Nimbus services in the managed container.'),
        ready: t('setup_phase_ready', 'Finalizing setup.'),
      }[stats.bootstrap_state || 'idle'] || t('setup_phase_idle', 'Preparing the managed environment.')
    : {
        idle: t('start_phase_idle', 'Nimbus is checking the managed container and restoring app status.'),
        'ensuring-profile': t('start_phase_ensuring_profile', 'Nimbus is checking the managed container configuration.'),
        'importing-image': t('start_phase_importing_image', 'Nimbus is importing the pre-built container image.'),
        'ensuring-container': t('start_phase_ensuring_container', 'Nimbus is starting the managed container.'),
        'starting-agent': t('start_phase_starting_agent', 'Nimbus is starting the managed services.'),
        ready: t('start_phase_ready', 'Nimbus is finishing startup.'),
      }[stats.bootstrap_state || 'idle'] || t('start_phase_idle', 'Nimbus is checking the managed container and restoring app status.')

  return {
    title: firstSetup ? t('setup_title_setting_up', 'Nimbus is setting up') : t('setup_title_starting', 'Nimbus is starting'),
    message: phaseMessage,
    ready: false,
    error: false,
  }
}

// The persistent app shell: ambient background, top bar, Dock, and routed
// pages. Mounted only once auth/OOBE/kiosk gating (in the outer App
// component) has determined the user should see the real app.
export function Shell({ stats, apps, activeInstalls, loading, error, authStatus, onLogout, onRefresh, onUninstall, onServiceAction }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const [appFrame, setAppFrame] = useState(null)
  const [detailApp, setDetailApp] = useState(null)
  const [logApp, setLogApp] = useState(null)
  const [powerMenuOpen, setPowerMenuOpen] = useState(false)
  const [powerBusy, setPowerBusy] = useState(null)
  const [systemNotice, setSystemNotice] = useState(null)
  const [locked, setLocked] = useState(false)
  const idleTimerRef = useRef(null)

  useEffect(() => {
    setKioskFallback((url, meta) => setAppFrame({ url, name: meta.name || '', remoteOnly: meta.remoteOnly || false, remoteUrl: meta.remoteUrl }))
  }, [])

  // Idle screen lock — only when auth is configured
  useEffect(() => {
    if (!authStatus?.configured) return
    const timeout = Number(window.localStorage.getItem('nimbus_idle_timeout')) || DEFAULT_IDLE_TIMEOUT_MS

    function resetTimer() {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = setTimeout(() => {
        if (localStorage.getItem('nimbus_lock_pin')) setLocked(true)
      }, timeout)
    }

    const events = ['mousemove', 'keydown', 'touchstart', 'click']
    events.forEach(ev => window.addEventListener(ev, resetTimer, { passive: true }))
    resetTimer()
    return () => {
      clearTimeout(idleTimerRef.current)
      events.forEach(ev => window.removeEventListener(ev, resetTimer))
    }
  }, [authStatus?.configured])

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
    await onUninstall(app)
  }

  async function handlePowerAction(action) {
    setPowerMenuOpen(false)
    setPowerBusy(action)
    try {
      if (action === 'restart') {
        await restartSystem()
        setSystemNotice({ tone: 'info', message: t('settings_system_restart_success_msg', 'Restart requested. Nimbus will disconnect while the system restarts.') })
      } else {
        await powerOffSystem()
        setSystemNotice({ tone: 'info', message: t('settings_system_poweroff_success_msg', 'Power off requested. Nimbus will disconnect while the system shuts down.') })
      }
    } catch (e) {
      setSystemNotice({ tone: 'error', message: e.message })
    } finally {
      setPowerBusy(null)
    }
  }

  // Ambient background warms and lightens with system load
  const load = stats ? (stats.cpu_pct + stats.mem_pct) / 2 + activeInstalls.length * 10 : 0

  const updatableCount = apps.filter(a => a.update_available).length
  const openclawInstalled = apps.some(a => a.id === 'openclaw' && a.installed)
  const hermesInstalled = apps.some(a => a.id === 'hermes-agent' && a.installed)
  const picoclawInstalled = apps.some(a => a.id === 'picoclaw' && a.installed)
  const nullclawInstalled = apps.some(a => a.id === 'nullclaw' && a.installed)
  const zeroclawInstalled = apps.some(a => a.id === 'zeroclaw' && a.installed)
  const odysseusInstalled = apps.some(a => a.id === 'odysseus' && a.installed)
  const hasWidgets = openclawInstalled || hermesInstalled || picoclawInstalled || nullclawInstalled || zeroclawInstalled || odysseusInstalled

  const errorMessage = error?.startsWith('Cannot reach backend') ? error : t('cannot_reach_backend_prefix', 'Cannot reach backend — {{error}}', { error })
  const setupState = describeSetupState(stats, apps, activeInstalls, t)
  const isHome = location.pathname === '/'

  const topBarControls = (
    <>
      {systemNotice && (
        <div style={{ ...styles.systemNotice, ...(systemNotice.tone === 'error' ? styles.systemNoticeError : {}) }}>
          {systemNotice.message}
        </div>
      )}
      {authStatus?.authenticated && authStatus?.configured && (
        <button style={styles.logoutBtn} onClick={onLogout} title={t('signed_in_as', 'Signed in as {{username}}', { username: authStatus.username || 'admin' })}>
          {authStatus.username || 'admin'} · {t('sign_out', 'Sign out')}
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
              ? t('power_unavailable_hint', 'Power controls are unavailable until Nimbus can access snapd on the host.')
              : t('power', 'Power')
          }
          onClick={e => {
            e.stopPropagation()
            setPowerMenuOpen(open => !open)
          }}
          disabled={powerBusy || (stats && !stats.device_management_available)}
        >
          <Power size={18} />
        </button>
        {powerMenuOpen && (
          <div style={styles.powerMenu} onClick={e => e.stopPropagation()}>
            <button style={styles.powerMenuItem} onClick={() => handlePowerAction('restart')} disabled={powerBusy}>
              {t('restart', 'Restart')}
            </button>
            <button style={{ ...styles.powerMenuItem, ...styles.powerMenuItemDanger }} onClick={() => handlePowerAction('poweroff')} disabled={powerBusy}>
              {t('power_off', 'Power Off')}
            </button>
          </div>
        )}
      </div>
    </>
  )

  return (
    <div className="desktop-container" style={{ ...styles.desktop, background: ambientGradient(load) }}>
      {locked && (
        <ScreenLock
          deviceName={stats?.host_ip ? `Nimbus @ ${stats.host_ip}` : 'Nimbus'}
          onUnlock={() => setLocked(false)}
          onFail={() => {}}
        />
      )}
      {/* On Home there's no page header competing for the top-right corner, so the
          controls float there. On every other route they dock into that page's
          own header instead — floating them here too would overlap long titles
          on narrow screens, since PageHeader occupies that same top band. */}
      {isHome && <div style={styles.topBar}>{topBarControls}</div>}

      {isHome && hasWidgets && (
        <div style={styles.widgetStack}>
          {odysseusInstalled && <AppStatusWidget appId="odysseus" title="Odysseus" />}
          {zeroclawInstalled && <AppStatusWidget appId="zeroclaw" title="ZeroClaw" />}
          {nullclawInstalled && <AppStatusWidget appId="nullclaw" title="NullClaw" />}
          {picoclawInstalled && <AppStatusWidget appId="picoclaw" title="PicoClaw" />}
          {hermesInstalled && <AppStatusWidget appId="hermes-agent" title="Hermes Agent" />}
          {openclawInstalled && <OpenClawWidget />}
        </div>
      )}

      <Routes>
        <Route path="/" element={
          <Home
            apps={apps}
            loading={loading}
            error={error}
            errorMessage={errorMessage}
            setupState={setupState}
            onOpenDetail={setDetailApp}
            onOpenLogs={setLogApp}
            onServiceAction={onServiceAction}
            onUninstall={handleUninstall}
          />
        } />
        <Route path="/app-store" element={
          <Page key="/app-store" title={t('dock_appstore', 'App Store')} headerActions={topBarControls}>
            <AppStore apps={apps} onRefresh={onRefresh} onOpenDetail={setDetailApp} activeInstalls={activeInstalls} />
          </Page>
        } />
        <Route path="/files" element={
          <Page key="/files" title={t('dock_files', 'Files')} noPad headerActions={topBarControls}>
            <FileBrowser />
          </Page>
        } />
        <Route path="/device-info" element={
          <Page key="/device-info" title={t('device_info_title', 'Device Info')} headerActions={topBarControls}>
            <DeviceInfo stats={stats} apps={apps} />
          </Page>
        } />
        <Route path="/settings" element={
          <Page key="/settings" title={t('dock_settings', 'Settings')} headerActions={topBarControls}>
            <Settings stats={stats} onRefresh={onRefresh} />
          </Page>
        } />
        <Route path="/terminal" element={
          <Page key="/terminal" title={t('dock_terminal', 'Terminal')} noPad headerActions={topBarControls}>
            <TerminalPanel />
          </Page>
        } />
      </Routes>

      <Dock
        onOpen={id => navigate(id === 'home' ? '/' : `/${id === 'deviceinfo' ? 'device-info' : id === 'appstore' ? 'app-store' : id}`)}
        activeId={ROUTE_TO_DOCK_ID[location.pathname]}
        updatableCount={updatableCount}
        appUpdateCount={stats?.update_available_count ?? 0}
        appstoreVisible={stats?.appstore_visible !== false}
        terminalAvailable={Boolean(stats?.terminal_available)}
        background={isHome ? undefined : 'var(--color-bg-canvas)'}
      />

      {logApp && (
        <Window title={`Logs — ${logApp.name}`} onClose={() => setLogApp(null)} noPad>
          <AppLogViewer appId={logApp.id} />
        </Window>
      )}

      <AppModal
        app={detailApp}
        isInstalling={detailApp ? activeInstalls.includes(detailApp.id) : false}
        onClose={() => setDetailApp(null)}
        onRefresh={() => { onRefresh(); setDetailApp(null) }}
      />

      {appFrame && (
        <AppFrameOverlay appFrame={appFrame} onClose={() => setAppFrame(null)} />
      )}

      <style>{`
        .desktop-container {
          height: 100vh;
          height: 100dvh;
          height: var(--vh, 100dvh);
        }
      `}</style>
    </div>
  )
}

export default function App() {
  const [apps, setApps] = useState([])
  const [stats, setStats] = useState(null)
  const [activeInstalls, setActiveInstalls] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [oobeComplete, setOobeComplete] = useState(true)
  // null = unknown (checking), { configured, authenticated, username, token } = known
  const [authStatus, setAuthStatus] = useState(null)
  const intervalRef = useRef(null)
  const sseRef = useRef(null)
  const sseBackoffRef = useRef(1000)
  // Set to true when the user explicitly completes OOBE this session so that
  // in-flight poll responses with oobe_complete=false cannot revert the state.
  const oobeCompletedRef = useRef(false)
  const authStatusRef = useRef(null)

  useEffect(() => {
    let link = document.querySelector('link[rel="manifest"]')
    if (oobeComplete) {
      if (!link) {
        link = document.createElement('link')
        link.rel = 'manifest'
        link.href = '/manifest.json'
        document.head.appendChild(link)
      }
    } else {
      if (link) {
        link.remove()
      }
    }
  }, [oobeComplete])

  async function checkAuth() {
    try {
      const status = await getAuthStatus()
      authStatusRef.current = status
      setAuthStatus(status)
      return status
    } catch {
      // If auth endpoint fails, assume open access
      const status = { configured: false, authenticated: true, username: null }
      authStatusRef.current = status
      setAuthStatus(status)
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
      if (statsData.oobe_complete === true) {
        setOobeComplete(true)
      } else if (statsData.oobe_complete === false && !oobeCompletedRef.current) {
        setOobeComplete(false)
      }
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

  function startSse() {
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null }
    const base = import.meta.env.VITE_API_BASE ?? '/api'
    const es = new EventSource(`${base}/system/stats/stream`, { withCredentials: true })
    sseRef.current = es
    es.onmessage = (ev) => {
      try {
        const statsData = JSON.parse(ev.data)
        if (!statsData.error) {
          setStats(statsData)
          setError(null)
          setLoading(false)
          sseBackoffRef.current = 1000
          if (statsData.oobe_complete === true) {
            setOobeComplete(true)
          } else if (statsData.oobe_complete === false && !oobeCompletedRef.current) {
            setOobeComplete(false)
          }
        }
      } catch {}
    }
    es.onerror = () => {
      es.close()
      sseRef.current = null
      // Exponential backoff (max 30s) then retry SSE; fall back to polling in the meantime
      const delay = Math.min(sseBackoffRef.current, 30000)
      sseBackoffRef.current = Math.min(delay * 2, 30000)
      setTimeout(startSse, delay)
    }
  }

  async function handleLogout() {
    try { await logout() } catch {}
    setAuthStatus(prev => ({ ...prev, authenticated: false }))
  }

  async function fetchAppsAndInstalls() {
    const auth = authStatusRef.current
    if (auth?.configured && !auth?.authenticated) return
    try {
      const [appsData, active] = await Promise.all([listApps(), getActiveInstalls()])
      setApps(appsData)
      setActiveInstalls(active)
    } catch (e) {
      if (e.message.startsWith('401:')) {
        try {
          await refreshSession()
          const [appsData, active] = await Promise.all([listApps(), getActiveInstalls()])
          setApps(appsData)
          setActiveInstalls(active)
        } catch {
          const next = authStatusRef.current ? { ...authStatusRef.current, authenticated: false } : null
          authStatusRef.current = next
          setAuthStatus(next)
          checkAuth()
        }
      }
    }
  }

  useEffect(() => {
    checkAuth().then(status => {
      // The kiosk display (isLocalAccess) has no login UI of its own — it
      // only ever shows Oobe or KioskReadyScreen — so once an account exists
      // elsewhere it would otherwise never authenticate and stats would stay
      // null forever. The backend's require_api_token_or_local grants read
      // access to /system/stats(/stream) for genuinely local callers, so it's
      // safe to always fetch here when running as the local kiosk.
      if (!status || status.authenticated || !status.configured || isLocalAccess()) {
        fetchAll()
        startSse()
      } else {
        setLoading(false)
      }
    })
    // Apps and active installs still use polling (less frequent); stats come via SSE
    intervalRef.current = setInterval(fetchAppsAndInstalls, POLL_INTERVAL * 3)
    return () => {
      clearInterval(intervalRef.current)
      if (sseRef.current) { sseRef.current.close(); sseRef.current = null }
    }
  }, [])

  async function handleUninstall(app) {
    try {
      await uninstallApp(app.id)
      fetchAll()
    } catch (e) {
      // ignore — card-level errors not applicable here
    }
  }

  async function handleServiceAction(app, action) {
    try {
      if (action === 'start') await startApp(app.id)
      else if (action === 'stop') await stopApp(app.id)
      else if (action === 'restart') await restartApp(app.id)
      fetchAll()
    } catch (e) {
      // ignore — errors surfaced in app card
    }
  }

  const kioskStyle = <style>{`body { overflow: hidden; }`}</style>

  if (isLocalAccess()) {
    if (!oobeComplete) {
      return (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'var(--color-bg-canvas)' }} />
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

  if (!oobeComplete) {
    return (
      <Oobe
        online={stats?.online ?? false}
        onComplete={() => {
          oobeCompletedRef.current = true
          setOobeComplete(true)
          checkAuth().then(() => fetchAll())
        }}
      />
    )
  }

  if (authStatus?.configured && !authStatus?.authenticated) {
    return <Login onLogin={() => checkAuth().then(() => fetchAll())} />
  }

  return (
    <HashRouter>
      <Shell
        stats={stats}
        apps={apps}
        activeInstalls={activeInstalls}
        loading={loading}
        error={error}
        authStatus={authStatus}
        onLogout={handleLogout}
        onRefresh={fetchAll}
        onUninstall={handleUninstall}
        onServiceAction={handleServiceAction}
      />
    </HashRouter>
  )
}

const styles = {
  desktop: {
    width: '100vw',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: 'var(--font-sans)',
    color: 'var(--text-primary)',
    position: 'relative',
    transition: 'background var(--duration-ambient) ease',
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
    background: 'var(--color-surface-3)',
    border: '1px solid var(--color-accent-soft-border)',
    color: 'var(--text-primary)',
    borderRadius: '14px',
    padding: '10px 14px',
    fontSize: '12px',
    lineHeight: 1.45,
    boxShadow: 'var(--shadow-md)',
    backdropFilter: 'blur(var(--blur-md))',
  },
  systemNoticeError: {
    border: '1px solid var(--color-danger-soft-border)',
    color: 'var(--color-danger-soft-text)',
  },
  logoutBtn: {
    background: 'var(--color-surface-3)',
    border: '1px solid var(--color-border-strong)',
    color: 'var(--text-secondary)',
    borderRadius: '12px',
    padding: '0 14px',
    height: '46px',
    fontSize: '12px',
    fontWeight: 500,
    cursor: 'pointer',
    boxShadow: 'var(--shadow-md)',
    backdropFilter: 'blur(var(--blur-lg))',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-sans)',
  },
  powerWrap: {
    position: 'relative',
  },
  powerButton: {
    width: '46px',
    height: '46px',
    borderRadius: '14px',
    border: '1px solid var(--color-border-strong)',
    background: 'var(--color-surface-3)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    boxShadow: 'var(--shadow-md)',
    backdropFilter: 'blur(var(--blur-lg))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  powerButtonActive: {
    border: '1px solid var(--color-warning-soft-border)',
    color: 'var(--color-warning-soft-text)',
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
    background: 'var(--nimbus-charcoal-900)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: '14px',
    padding: '6px',
    boxShadow: 'var(--shadow-lg)',
    backdropFilter: 'blur(var(--blur-lg))',
  },
  powerMenuItem: {
    width: '100%',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-primary)',
    padding: '10px 12px',
    borderRadius: '10px',
    fontSize: '13px',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  },
  powerMenuItemDanger: {
    color: 'var(--color-danger)',
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
    background: 'var(--nimbus-charcoal-950)',
    borderBottom: '1px solid var(--color-border-subtle)',
    flexShrink: 0,
  },
  frameBack: {
    background: 'var(--color-accent-soft-bg)',
    border: '1px solid var(--color-accent-soft-border)',
    color: 'var(--color-accent-soft-text)',
    borderRadius: '10px',
    padding: '6px 14px',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-sans)',
  },
  frameTitle: {
    fontSize: '14px',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    flex: 1,
    fontFamily: 'var(--font-sans)',
  },
  frameExternal: {
    background: 'var(--color-surface-3)',
    border: '1px solid var(--color-border-strong)',
    color: 'var(--text-secondary)',
    borderRadius: '8px',
    padding: '5px 12px',
    fontSize: '12px',
    fontWeight: 500,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    fontFamily: 'var(--font-sans)',
  },
  frameContent: {
    flex: 1,
    border: 'none',
    width: '100%',
  },
  frameOverlayFull: {
    zIndex: 9500,
  },
  fullscreenExit: {
    position: 'fixed',
    top: 12,
    right: 16,
    zIndex: 9600,
    background: 'rgba(0,0,0,0.6)',
    border: '1px solid rgba(255,255,255,0.2)',
    color: 'rgba(255,255,255,0.8)',
    borderRadius: 8,
    padding: '5px 12px',
    fontSize: 12,
    cursor: 'pointer',
  },
}
