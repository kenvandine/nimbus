import { useState, useEffect, useRef } from 'react'
import SystemLogViewer from './SystemLogViewer'
import { getModelStatus, pullModel, ensureModel, getAvailableModels, selectModel } from '../api.js'

const BASE = import.meta.env.VITE_API_BASE ?? '/api'

async function apiRequest(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...options })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json()
}

function Gauge({ label, value, color }) {
  return (
    <div style={styles.gaugeWrap}>
      <div style={styles.gaugeHeader}>
        <span style={styles.gaugeLabel}>{label}</span>
        <span style={styles.gaugeValue}>{Math.round(value)}%</span>
      </div>
      <div style={styles.track}>
        <div style={{ ...styles.fill, width: `${value}%`, background: color }} />
      </div>
    </div>
  )
}

function InfoRow({ label, value }) {
  return (
    <div style={styles.infoRow}>
      <span style={styles.infoLabel}>{label}</span>
      <span style={styles.infoValue}>{value}</span>
    </div>
  )
}

function formatBootstrapState(state) {
  const labels = {
    idle: 'Waiting to start',
    'ensuring-profile': 'Configuring LXD profile',
    'ensuring-container': 'Creating managed container',
    'installing-runtime': 'Installing container runtime',
    'pushing-agent': 'Copying Nimbus services',
    'installing-agent-python': 'Installing Python dependencies',
    'starting-agent': 'Starting Nimbus agent',
    ready: 'Ready',
    error: 'Error',
  }
  return labels[state] || state || 'Unknown'
}

function SnapshotsTab({ containerReady }) {
  const [snapshots, setSnapshots] = useState(null)
  const [busy, setBusy] = useState(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState(null)
  const [confirmRestore, setConfirmRestore] = useState(null)

  async function load() {
    try {
      const data = await apiRequest('/snapshots')
      setSnapshots(data)
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => { if (containerReady) load() }, [containerReady])

  async function handleCreate() {
    if (!newName.trim()) return
    setBusy('create')
    setError(null)
    try {
      await apiRequest('/snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      })
      setNewName('')
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete(name) {
    setBusy(`del-${name}`)
    setError(null)
    try {
      await apiRequest(`/snapshots/${encodeURIComponent(name)}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  async function handleRestore(name) {
    setConfirmRestore(null)
    setBusy(`restore-${name}`)
    setError(null)
    try {
      await apiRequest(`/snapshots/${encodeURIComponent(name)}/restore`, { method: 'POST' })
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  if (!containerReady) {
    return <p style={styles.muted}>Container must be running and ready to manage snapshots.</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={styles.snapshotRow}>
        <input
          style={styles.snapInput}
          placeholder="Snapshot name"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleCreate()}
        />
        <button
          style={{ ...styles.btnPrimary, ...(busy === 'create' ? styles.btnDisabled : {}) }}
          onClick={handleCreate}
          disabled={busy === 'create' || !newName.trim()}
        >
          {busy === 'create' ? 'Creating…' : 'Create'}
        </button>
      </div>

      {error && <div style={styles.errorText}>{error}</div>}

      {snapshots === null && <p style={styles.muted}>Loading…</p>}
      {snapshots !== null && snapshots.length === 0 && (
        <p style={styles.muted}>No snapshots yet. Create one to save the container state.</p>
      )}
      {snapshots !== null && snapshots.map(snap => (
        <div key={snap.name} style={styles.snapCard}>
          <div style={{ flex: 1 }}>
            <div style={styles.snapName}>{snap.name}</div>
            {snap.created_at && (
              <div style={styles.snapDate}>{new Date(snap.created_at).toLocaleString()}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={{ ...styles.btnSecondary, ...(busy ? styles.btnDisabled : {}) }}
              onClick={() => setConfirmRestore(snap.name)}
              disabled={Boolean(busy)}
            >
              Restore
            </button>
            <button
              style={{ ...styles.btnDanger, ...(busy ? styles.btnDisabled : {}) }}
              onClick={() => handleDelete(snap.name)}
              disabled={Boolean(busy)}
            >
              {busy === `del-${snap.name}` ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      ))}

      {confirmRestore && (
        <div style={styles.confirmOverlay}>
          <div style={styles.confirmCard}>
            <div style={styles.confirmTitle}>Restore Snapshot</div>
            <p style={styles.confirmMsg}>
              Restoring <strong>{confirmRestore}</strong> will revert the container to that state.
              All changes since the snapshot will be lost.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button style={styles.btnSecondary} onClick={() => setConfirmRestore(null)}>Cancel</button>
              <button
                style={{ ...styles.btnDanger, ...(busy ? styles.btnDisabled : {}) }}
                onClick={() => handleRestore(confirmRestore)}
                disabled={Boolean(busy)}
              >
                {busy === `restore-${confirmRestore}` ? 'Restoring…' : 'Restore'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AiModelTab() {
  const [modelStatus, setModelStatus] = useState(null)
  const [availableModels, setAvailableModels] = useState([])
  const [selectedModel, setSelectedModel] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [msg, setMsg] = useState(null)
  const pollRef = useRef(null)

  async function load() {
    try {
      const [status, models] = await Promise.all([getModelStatus(), getAvailableModels()])
      setModelStatus(status)
      setAvailableModels(models)
      if (selectedModel === null && status?.model_id) {
        setSelectedModel(status.model_id)
      }
    } catch (e) { setError(e.message) }
  }

  useEffect(() => { load() }, [])

  // Poll while a pull/select is in progress.
  useEffect(() => {
    const pulling = modelStatus?.pull?.status &&
      !['idle', 'ready', 'failed', 'skipped'].includes(modelStatus.pull.status)
    if (pulling && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        try {
          const s = await getModelStatus()
          setModelStatus(s)
          if (['idle', 'ready', 'failed', 'skipped'].includes(s?.pull?.status)) {
            clearInterval(pollRef.current)
            pollRef.current = null
            if (s?.pull?.status === 'ready') setMsg('Model ready.')
            if (s?.pull?.status === 'failed') setError(s.pull.error || 'Pull failed.')
            setBusy(null)
          }
        } catch {}
      }, 3000)
    }
    return () => {}
  }, [modelStatus?.pull?.status])

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  async function handlePull() {
    setBusy('pull'); setError(null); setMsg(null)
    try { await pullModel(); setMsg('Model download started. This may take a while.'); await load() }
    catch (e) { setError(e.message); setBusy(null) }
  }

  async function handleEnsure() {
    setBusy('ensure'); setError(null); setMsg(null)
    try { await ensureModel(); setMsg('Model verification started.'); await load() }
    catch (e) { setError(e.message); setBusy(null) }
  }

  async function handleSelect() {
    if (!selectedModel || selectedModel === modelStatus?.model_id) return
    setBusy('select'); setError(null); setMsg(null)
    try {
      await selectModel(selectedModel)
      setMsg('Switching model… this may take a while.')
      await load()
    } catch (e) { setError(e.message); setBusy(null) }
  }

  const pull = modelStatus?.pull
  const lemon = modelStatus?.lemonade
  const currentModelId = modelStatus?.model_id
  const isDifferent = selectedModel && selectedModel !== currentModelId
  const selectedModelInfo = availableModels.find(m => m.model_name === selectedModel)
  const isPulling = pull?.status && !['idle', 'ready', 'failed', 'skipped'].includes(pull.status)

  function friendlyModelName(modelName) {
    if (!modelName) return '—'
    return modelName.replace(/^user\./, '')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && <div style={{ color: '#ff8a80', fontSize: 12 }}>{error}</div>}
      {msg && <div style={{ color: 'rgba(129,199,132,0.9)', fontSize: 12 }}>{msg}</div>}

      {modelStatus === null && <p style={styles.muted}>Loading…</p>}
      {modelStatus !== null && (
        <>
          <div style={styles.infoTable}>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>Provider</span>
              <span style={styles.infoValue}>{modelStatus.provider || '—'}</span>
            </div>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>Active Model</span>
              <span style={{ ...styles.infoValue, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                {friendlyModelName(currentModelId)}
              </span>
            </div>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>Status</span>
              <span style={{ ...styles.infoValue, color: modelStatus.status === 'ready' ? 'rgba(129,199,132,0.9)' : 'rgba(255,255,255,0.5)' }}>
                {modelStatus.status || '—'}
              </span>
            </div>
            {lemon && (
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Lemonade</span>
                <span style={{ ...styles.infoValue, color: lemon.reachable ? 'rgba(129,199,132,0.9)' : 'rgba(255,138,128,0.8)' }}>
                  {lemon.reachable ? 'Running' : 'Not reachable'}
                </span>
              </div>
            )}
            {isPulling && (
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Download</span>
                <span style={styles.infoValue}>
                  {pull.status} {pull.percent > 0 ? `(${Math.round(pull.percent)}%)` : ''}
                  {pull.total_files > 0 ? ` — file ${pull.file_index}/${pull.total_files}` : ''}
                </span>
              </div>
            )}
          </div>

          {availableModels.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>Change Model</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select
                  value={selectedModel || currentModelId || ''}
                  onChange={e => setSelectedModel(e.target.value)}
                  disabled={Boolean(busy)}
                  style={styles.modelSelect}
                >
                  {availableModels.map(m => (
                    <option key={m.model_name} value={m.model_name}>
                      {m.downloaded ? '✓ ' : '↓ '}
                      {friendlyModelName(m.model_name)}
                      {m.size ? ` — ${m.size} GB` : ''}
                      {m.labels?.length ? ` (${m.labels.join(', ')})` : ''}
                    </option>
                  ))}
                </select>
                <button
                  style={{
                    ...styles.btnPrimary,
                    ...((!isDifferent || busy) ? styles.btnDisabled : {}),
                    whiteSpace: 'nowrap',
                  }}
                  onClick={handleSelect}
                  disabled={!isDifferent || Boolean(busy)}
                >
                  {busy === 'select'
                    ? 'Switching…'
                    : selectedModelInfo?.downloaded
                      ? 'Apply'
                      : 'Pull & Apply'}
                </button>
              </div>
              {isDifferent && (
                <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', margin: 0 }}>
                  {selectedModelInfo?.downloaded
                    ? 'Will load the model and re-run auto-config for installed apps.'
                    : 'Will download the model, then re-run auto-config for installed apps.'}
                </p>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={{ ...styles.btnPrimary, ...(busy === 'ensure' ? styles.btnDisabled : {}) }}
              onClick={handleEnsure}
              disabled={Boolean(busy)}
            >
              {busy === 'ensure' ? 'Verifying…' : 'Verify / Load'}
            </button>
            <button
              style={{ ...styles.btnSecondary, ...(busy === 'pull' ? styles.btnDisabled : {}) }}
              onClick={handlePull}
              disabled={Boolean(busy)}
            >
              {busy === 'pull' ? 'Pulling…' : 'Re-pull Model'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default function DeviceInfo({ stats, apps }) {
  const running = apps?.filter(a => a.running).length ?? 0
  const installed = apps?.filter(a => a.installed).length ?? 0
  const updates = apps?.filter(a => a.update_available).length ?? 0
  const setupPending = stats?.control_mode === 'lxd' && (!stats?.container_bootstrapped || stats?.container_status !== 'running' || stats?.bootstrap_state !== 'ready')
  const firstSetup = !stats?.container_bootstrapped
  const isLxd = stats?.control_mode === 'lxd'
  const containerReady = isLxd && stats?.container_bootstrapped && stats?.container_status === 'running' && stats?.bootstrap_state === 'ready'
  const [logSource, setLogSource] = useState('host')
  const [activeTab, setActiveTab] = useState('overview')

  const tabs = [
    { id: 'overview', label: 'Overview' },
    ...(isLxd ? [{ id: 'snapshots', label: 'Snapshots' }] : []),
    { id: 'ai', label: 'AI Model' },
    { id: 'logs', label: 'Logs' },
  ]

  return (
    <div style={styles.container}>
      {setupPending && (
        <section style={styles.setupBanner}>
          <div style={styles.setupBannerTitle}>{firstSetup ? 'Nimbus is still being set up' : 'Nimbus is still starting'}</div>
          <div style={styles.setupBannerText}>
            {stats?.bootstrap_error
              ? `Setup failed: ${stats.bootstrap_error}`
              : `${formatBootstrapState(stats?.bootstrap_state)}. ${firstSetup ? 'The managed LXD container is not ready for normal use yet.' : 'Nimbus is reconnecting to the managed container and restoring app state.'}`}
          </div>
        </section>
      )}

      <div style={styles.tabRow}>
        {tabs.map(t => (
          <button
            key={t.id}
            style={{ ...styles.tab, ...(activeTab === t.id ? styles.tabActive : {}) }}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <>
          <section style={styles.section}>
            <h3 style={styles.sectionTitle}>System Resources</h3>
            {stats ? (
              <>
                <Gauge label="CPU" value={stats.cpu_pct} color="#4fc3f7" />
                <Gauge label="Memory" value={stats.mem_pct} color="#81d4fa" />
                <Gauge label="Disk" value={stats.disk_pct} color="#b3e5fc" />
              </>
            ) : (
              <p style={styles.muted}>Loading…</p>
            )}
          </section>

          <section style={styles.section}>
            <h3 style={styles.sectionTitle}>Apps</h3>
            <div style={styles.statGrid}>
              <StatTile value={installed} label="Installed" color="#4fc3f7" />
              <StatTile value={running} label="Running" color="#4caf50" />
              <StatTile value={updates} label="Updates" color="#ff9800" />
            </div>
          </section>

          <section style={styles.section}>
            <h3 style={styles.sectionTitle}>Platform</h3>
            <div style={styles.infoTable}>
              <InfoRow label="Service" value={stats?.version ? `Nimbus v${stats.version}` : 'Nimbus'} />
              <InfoRow label="Runtime" value={stats?.control_mode === 'lxd' ? 'SnapD + LXD' : 'Docker + LXD'} />
              <InfoRow label="App Catalog" value={stats?.app_store_type === 'umbrel' ? 'Umbrel App Store' : 'Nimbus App Store'} />
              {stats?.container_name && <InfoRow label="Managed Container" value={stats.container_name} />}
              {stats?.container_status && <InfoRow label="Container State" value={stats.container_status} />}
              {stats?.container_ip && <InfoRow label="Container IP" value={stats.container_ip} />}
              {stats?.bootstrap_state && <InfoRow label="Bootstrap" value={formatBootstrapState(stats.bootstrap_state)} />}
              {stats?.tls_enabled && stats?.tls_fingerprint && (
                <InfoRow label="TLS Fingerprint" value={stats.tls_fingerprint} />
              )}
            </div>
            {stats?.bootstrap_error && (
              <p style={styles.errorText}>Container bootstrap error: {stats.bootstrap_error}</p>
            )}
          </section>
        </>
      )}

      {activeTab === 'snapshots' && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>Container Snapshots</h3>
          <SnapshotsTab containerReady={containerReady} />
        </section>
      )}

      {activeTab === 'ai' && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>AI Model</h3>
          <AiModelTab />
        </section>
      )}

      {activeTab === 'logs' && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>Logs</h3>
          <div style={styles.logTabs}>
            <button
              style={{ ...styles.tab, ...(logSource === 'host' ? styles.tabActive : {}) }}
              onClick={() => setLogSource('host')}
            >
              Host
            </button>
            {isLxd && (
              <button
                style={{ ...styles.tab, ...(logSource === 'lxc' ? styles.tabActive : {}) }}
                onClick={() => setLogSource('lxc')}
              >
                Container
              </button>
            )}
          </div>
          <SystemLogViewer source={logSource} />
        </section>
      )}
    </div>
  )
}

function StatTile({ value, label, color }) {
  return (
    <div style={styles.tile}>
      <span style={{ ...styles.tileValue, color }}>{value}</span>
      <span style={styles.tileLabel}>{label}</span>
    </div>
  )
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', gap: '28px' },
  setupBanner: {
    padding: '16px 18px',
    borderRadius: '14px',
    background: 'rgba(79,195,247,0.12)',
    border: '1px solid rgba(79,195,247,0.24)',
  },
  setupBannerTitle: {
    color: '#b3e5fc',
    fontSize: '14px',
    fontWeight: 700,
    marginBottom: '6px',
  },
  setupBannerText: {
    color: 'rgba(255,255,255,0.76)',
    fontSize: '13px',
    lineHeight: 1.5,
  },
  tabRow: { display: 'flex', gap: '6px', borderBottom: '1px solid rgba(255,255,255,0.07)', paddingBottom: '2px' },
  section: {},
  sectionTitle: {
    color: 'rgba(255,255,255,0.38)',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    margin: '0 0 14px',
  },
  gaugeWrap: { marginBottom: '14px' },
  gaugeHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' },
  gaugeLabel: { color: 'rgba(255,255,255,0.65)', fontSize: '13px' },
  gaugeValue: { color: 'rgba(255,255,255,0.45)', fontSize: '13px' },
  track: { height: '8px', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: '4px', transition: 'width 0.6s ease' },
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px' },
  tile: {
    background: 'rgba(255,255,255,0.06)',
    borderRadius: '12px',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
  },
  tileValue: { fontSize: '28px', fontWeight: 700, lineHeight: 1 },
  tileLabel: { color: 'rgba(255,255,255,0.45)', fontSize: '12px' },
  infoTable: {
    background: 'rgba(255,255,255,0.04)',
    borderRadius: '12px',
    overflow: 'hidden',
  },
  infoRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '11px 16px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  infoLabel: { color: 'rgba(255,255,255,0.45)', fontSize: '13px' },
  infoValue: { color: 'rgba(255,255,255,0.8)', fontSize: '13px', fontWeight: 500 },
  muted: { color: 'rgba(255,255,255,0.3)', fontSize: '13px' },
  errorText: { color: '#ff8a80', fontSize: '12px', margin: '10px 0 0' },
  logTabs: { display: 'flex', gap: '6px', marginBottom: '10px' },
  tab: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)',
    color: 'rgba(255,255,255,0.5)',
    borderRadius: '8px',
    padding: '5px 16px',
    fontSize: '12px',
    cursor: 'pointer',
    fontWeight: 500,
  },
  tabActive: {
    background: 'rgba(79,195,247,0.15)',
    border: '1px solid rgba(79,195,247,0.35)',
    color: '#4fc3f7',
  },
  snapshotRow: { display: 'flex', gap: 8 },
  snapInput: {
    flex: 1,
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px',
    padding: '8px 12px',
    color: 'rgba(255,255,255,0.85)',
    fontSize: '13px',
    outline: 'none',
  },
  snapCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 10,
    padding: '12px 14px',
  },
  snapName: { color: 'rgba(255,255,255,0.85)', fontSize: '13px', fontWeight: 600 },
  snapDate: { color: 'rgba(255,255,255,0.35)', fontSize: '11px', marginTop: 2 },
  btnPrimary: {
    background: 'rgba(79,195,247,0.18)',
    color: 'rgba(79,195,247,0.98)',
    border: '1px solid rgba(79,195,247,0.3)',
    borderRadius: '8px',
    padding: '7px 14px',
    fontSize: '12px',
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnSecondary: {
    background: 'rgba(255,255,255,0.07)',
    color: 'rgba(255,255,255,0.6)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '8px',
    padding: '6px 12px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnDanger: {
    background: 'rgba(255,138,128,0.12)',
    color: 'rgba(255,138,128,0.9)',
    border: '1px solid rgba(255,138,128,0.25)',
    borderRadius: '8px',
    padding: '6px 12px',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  modelSelect: {
    flex: 1,
    background: 'rgba(255,255,255,0.07)',
    color: 'rgba(255,255,255,0.85)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px',
    padding: '6px 10px',
    fontSize: '12px',
    cursor: 'pointer',
    outline: 'none',
  },
  confirmOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  confirmCard: {
    background: 'rgba(15,25,40,0.97)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 16,
    padding: '24px',
    maxWidth: 400,
    width: '90%',
  },
  confirmTitle: { color: 'white', fontSize: 16, fontWeight: 700, marginBottom: 10 },
  confirmMsg: { color: 'rgba(255,255,255,0.65)', fontSize: 13, lineHeight: 1.5, margin: '0 0 18px' },
}
