import { useState, useEffect, useRef } from 'react'
import SystemLogViewer from './SystemLogViewer'
import { getModelStatus, pullModel, ensureModel, getAvailableModels, selectModel, getHardwareInfo } from '../api.js'
import Button from './ui/Button.jsx'

const BASE = import.meta.env.VITE_API_BASE ?? '/api'

async function apiRequest(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin', ...options })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json()
}

function Gauge({ label, value, color, subtitle }) {
  return (
    <div style={styles.gaugeWrap}>
      <div style={styles.gaugeHeader}>
        <span style={styles.gaugeLabel}>{label}</span>
        <span style={styles.gaugeValue}>
          {subtitle ? subtitle : `${Math.round(value)}%`}
        </span>
      </div>
      <div style={styles.track}>
        <div style={{ ...styles.fill, width: `${Math.min(value, 100)}%`, background: color }} />
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
        <Button variant="soft" size="sm" onClick={handleCreate} disabled={busy === 'create' || !newName.trim()} loading={busy === 'create'}>
          {busy === 'create' ? 'Creating…' : 'Create'}
        </Button>
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
            <Button variant="secondary" size="sm" onClick={() => setConfirmRestore(snap.name)} disabled={Boolean(busy)}>
              Restore
            </Button>
            <Button variant="danger" size="sm" onClick={() => handleDelete(snap.name)} disabled={Boolean(busy)} loading={busy === `del-${snap.name}`}>
              {busy === `del-${snap.name}` ? 'Deleting…' : 'Delete'}
            </Button>
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
              <Button variant="secondary" size="sm" onClick={() => setConfirmRestore(null)}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={() => handleRestore(confirmRestore)} disabled={Boolean(busy)} loading={busy === `restore-${confirmRestore}`}>
                {busy === `restore-${confirmRestore}` ? 'Restoring…' : 'Restore'}
              </Button>
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
      {error && <div style={{ color: 'var(--color-danger)', fontSize: 12 }}>{error}</div>}
      {msg && <div style={{ color: 'var(--color-success)', fontSize: 12 }}>{msg}</div>}

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
              <span style={{ ...styles.infoValue, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {friendlyModelName(currentModelId)}
              </span>
            </div>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>Status</span>
              <span style={{ ...styles.infoValue, color: modelStatus.status === 'ready' ? 'var(--color-success)' : 'var(--text-secondary)' }}>
                {modelStatus.status || '—'}
              </span>
            </div>
            {lemon && (
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Lemonade</span>
                <span style={{ ...styles.infoValue, color: lemon.reachable ? 'var(--color-success)' : 'var(--color-danger)' }}>
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
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>Change Model</label>
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
                <Button variant="soft" size="sm" onClick={handleSelect} disabled={!isDifferent || Boolean(busy)} loading={busy === 'select'} style={{ whiteSpace: 'nowrap' }}>
                  {busy === 'select' ? 'Switching…' : selectedModelInfo?.downloaded ? 'Apply' : 'Pull & Apply'}
                </Button>
              </div>
              {isDifferent && (
                <p style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: 0, fontFamily: 'var(--font-sans)' }}>
                  {selectedModelInfo?.downloaded
                    ? 'Will load the model and re-run auto-config for installed apps.'
                    : 'Will download the model, then re-run auto-config for installed apps.'}
                </p>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="soft" size="sm" onClick={handleEnsure} disabled={Boolean(busy)} loading={busy === 'ensure'}>
              {busy === 'ensure' ? 'Verifying…' : 'Verify / Load'}
            </Button>
            <Button variant="secondary" size="sm" onClick={handlePull} disabled={Boolean(busy)} loading={busy === 'pull'}>
              {busy === 'pull' ? 'Pulling…' : 'Re-pull Model'}
            </Button>
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
  const [hardware, setHardware] = useState(null)

  useEffect(() => {
    getHardwareInfo().then(setHardware).catch(() => {})
  }, [])

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
                <Gauge label="CPU" value={stats.cpu_pct} color="var(--color-accent)" />
                <Gauge
                  label="Memory"
                  value={stats.mem_pct}
                  color="var(--color-info)"
                  subtitle={stats.mem_total_gb ? `${stats.mem_used_gb} / ${hardware?.ram_gb ?? stats.mem_total_gb} GB` : undefined}
                />
                <Gauge
                  label="Disk"
                  value={stats.disk_pct}
                  color="var(--nimbus-sky-300)"
                  subtitle={stats.disk_total_gb ? `${stats.disk_used_gb} / ${stats.disk_total_gb} GB` : undefined}
                />
              </>
            ) : (
              <p style={styles.muted}>Loading…</p>
            )}
          </section>

          {hardware && (
            <section style={styles.section}>
              <h3 style={styles.sectionTitle}>Hardware</h3>
              <div style={styles.infoTable}>
                {hardware.system_name && <InfoRow label="System" value={hardware.system_name} />}
                {hardware.chassis_type && <InfoRow label="Form Factor" value={hardware.chassis_type} />}
                {hardware.cpu_model && (
                  <InfoRow
                    label="CPU"
                    value={
                      hardware.cpu_cores_physical
                        ? `${hardware.cpu_model} (${hardware.cpu_cores_physical}C / ${hardware.cpu_cores_logical}T)`
                        : hardware.cpu_model
                    }
                  />
                )}
                {hardware.gpu && <InfoRow label="GPU" value={hardware.gpu} />}
                {hardware.ram_gb && <InfoRow label="RAM" value={`${hardware.ram_gb} GB`} />}
              </div>
            </section>
          )}

          <section style={styles.section}>
            <h3 style={styles.sectionTitle}>Apps</h3>
            <div style={styles.statGrid}>
              <StatTile value={installed} label="Installed" color="var(--color-info)" />
              <StatTile value={running} label="Running" color="var(--color-success)" />
              <StatTile value={updates} label="Updates" color="var(--color-warning)" />
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
  container: { display: 'flex', flexDirection: 'column', gap: '28px', fontFamily: 'var(--font-sans)' },
  setupBanner: {
    padding: '16px 18px',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-accent-soft-bg)',
    border: '1px solid var(--color-accent-soft-border)',
  },
  setupBannerTitle: {
    color: 'var(--color-accent-soft-text)',
    fontSize: '14px',
    fontWeight: 700,
    marginBottom: '6px',
  },
  setupBannerText: {
    color: 'var(--text-primary)',
    fontSize: '13px',
    lineHeight: 1.5,
  },
  tabRow: { display: 'flex', gap: '6px', borderBottom: '1px solid var(--color-border-subtle)', paddingBottom: '2px' },
  section: {},
  sectionTitle: {
    color: 'var(--text-tertiary)',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    margin: '0 0 14px',
  },
  gaugeWrap: { marginBottom: '14px' },
  gaugeHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' },
  gaugeLabel: { color: 'var(--text-secondary)', fontSize: '13px' },
  gaugeValue: { color: 'var(--text-tertiary)', fontSize: '13px' },
  track: { height: '8px', background: 'var(--color-surface-3)', borderRadius: '4px', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: '4px', transition: 'width 0.6s ease' },
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px' },
  tile: {
    background: 'var(--color-surface-2)',
    borderRadius: 'var(--radius-md)',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
  },
  tileValue: { fontSize: '28px', fontWeight: 700, lineHeight: 1 },
  tileLabel: { color: 'var(--text-tertiary)', fontSize: '12px' },
  infoTable: {
    background: 'var(--color-surface-1)',
    borderRadius: 'var(--radius-md)',
    overflow: 'hidden',
  },
  infoRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '11px 16px',
    borderBottom: '1px solid var(--color-border-subtle)',
  },
  infoLabel: { color: 'var(--text-tertiary)', fontSize: '13px' },
  infoValue: { color: 'var(--text-primary)', fontSize: '13px', fontWeight: 500 },
  muted: { color: 'var(--text-tertiary)', fontSize: '13px' },
  errorText: { color: 'var(--color-danger)', fontSize: '12px', margin: '10px 0 0' },
  logTabs: { display: 'flex', gap: '6px', marginBottom: '10px' },
  tab: {
    background: 'var(--color-surface-3)',
    border: '1px solid var(--color-border-subtle)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--radius-sm)',
    padding: '5px 16px',
    fontSize: '12px',
    cursor: 'pointer',
    fontWeight: 500,
    fontFamily: 'var(--font-sans)',
  },
  tabActive: {
    background: 'var(--color-accent-soft-bg)',
    border: '1px solid var(--color-accent-soft-border)',
    color: 'var(--color-accent-soft-text)',
  },
  snapshotRow: { display: 'flex', gap: 8 },
  snapInput: {
    flex: 1,
    minHeight: 34,
    background: 'var(--color-surface-2)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-sm)',
    padding: '8px 12px',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
    fontSize: '13px',
    outline: 'none',
  },
  snapCard: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    background: 'var(--color-surface-1)',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-md)',
    padding: '12px 14px',
  },
  snapName: { color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600 },
  snapDate: { color: 'var(--text-tertiary)', fontSize: '11px', marginTop: 2 },
  modelSelect: {
    flex: 1,
    background: 'var(--color-surface-2)',
    color: 'var(--text-primary)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-sm)',
    padding: '6px 10px',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
    cursor: 'pointer',
    outline: 'none',
  },
  confirmOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'var(--color-overlay-scrim)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  confirmCard: {
    background: 'var(--nimbus-charcoal-900)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-lg)',
    padding: '24px',
    maxWidth: 400,
    width: '90%',
    boxShadow: 'var(--shadow-xl)',
  },
  confirmTitle: { color: 'var(--text-primary)', fontSize: 16, fontWeight: 700, marginBottom: 10 },
  confirmMsg: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.5, margin: '0 0 18px' },
}
