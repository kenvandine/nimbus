import { useState, useEffect, useRef } from 'react'
import SystemLogViewer from './SystemLogViewer'
import { getModelStatus, pullModel, ensureModel, getAvailableModels, selectModel, getHardwareInfo,
  getCloudStatus, getCloudPresets, listCloudProviders, addCloudProvider, deleteCloudProvider,
  getCloudProviderModels, saveCloudPolicy, getCloudUsage } from '../api.js'
import Button from './ui/Button.jsx'
import { useTranslation } from '../i18n.jsx'

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

function UsageSplitBar({ local, cloud, t }) {
  const total = local + cloud
  if (total === 0) return null
  const localPct = Math.round((local / total) * 100)
  const cloudPct = 100 - localPct
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={styles.usageBarTrack}>
        <div style={{ ...styles.usageBarSegment, width: `${localPct}%`, background: 'var(--color-accent)', borderRadius: '4px 0 0 4px' }} />
        <div style={{ width: 2 }} />
        <div style={{ ...styles.usageBarSegment, width: `${cloudPct}%`, background: 'var(--color-info)', borderRadius: '0 4px 4px 0' }} />
      </div>
      <div style={styles.usageLegend}>
        <span style={styles.usageLegendItem}>
          <span style={{ ...styles.usageDot, background: 'var(--color-accent)' }} />
          {t('cloud_offload_usage_local', 'Local')} {local.toLocaleString()} ({localPct}%)
        </span>
        <span style={styles.usageLegendItem}>
          <span style={{ ...styles.usageDot, background: 'var(--color-info)' }} />
          {t('cloud_offload_usage_cloud', 'Cloud')} {cloud.toLocaleString()} ({cloudPct}%)
        </span>
      </div>
    </div>
  )
}

function UsageTrend({ daily, t }) {
  const [showTable, setShowTable] = useState(false)
  const max = Math.max(1, ...daily.map(d => d.local_requests + d.cloud_requests))
  const barMaxHeight = 40

  return (
    <div>
      <div style={styles.usageTrendStrip}>
        {daily.map(d => {
          const dayTotal = d.local_requests + d.cloud_requests
          const localHeight = dayTotal ? Math.max(1, Math.round((d.local_requests / max) * barMaxHeight)) : 0
          const cloudHeight = dayTotal ? Math.max(1, Math.round((d.cloud_requests / max) * barMaxHeight)) : 0
          return (
            <div
              key={d.date}
              style={styles.usageTrendCol}
              title={`${d.date}: ${d.local_requests.toLocaleString()} ${t('cloud_offload_usage_local', 'Local')} · ${d.cloud_requests.toLocaleString()} ${t('cloud_offload_usage_cloud', 'Cloud')}`}
            >
              {d.cloud_requests > 0 && (
                <div style={{ width: '100%', height: cloudHeight, background: 'var(--color-info)', borderRadius: '2px 2px 0 0' }} />
              )}
              {d.local_requests > 0 && d.cloud_requests > 0 && <div style={{ height: 2 }} />}
              {d.local_requests > 0 && (
                <div style={{ width: '100%', height: localHeight, background: 'var(--color-accent)', borderRadius: d.cloud_requests > 0 ? '0' : '2px 2px 0 0' }} />
              )}
            </div>
          )
        })}
      </div>
      <div style={styles.usageTrendAxis}>
        <span>{daily[0]?.date}</span>
        <span>{daily[daily.length - 1]?.date}</span>
      </div>
      <button style={styles.advancedToggle} onClick={() => setShowTable(v => !v)}>
        {showTable
          ? t('cloud_offload_usage_hide_table', 'Hide table')
          : t('cloud_offload_usage_view_table', 'View as table')}
      </button>
      {showTable && (
        <div style={{ ...styles.infoTable, marginTop: 8 }}>
          {daily.map(d => (
            <div key={d.date} style={styles.infoRow}>
              <span style={styles.infoLabel}>{d.date}</span>
              <span style={styles.infoValue}>
                {d.local_requests.toLocaleString()} {t('cloud_offload_usage_local', 'Local')} · {d.cloud_requests.toLocaleString()} {t('cloud_offload_usage_cloud', 'Cloud')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function formatBootstrapState(state, t) {
  const labels = {
    idle: t('device_info_phase_idle', 'Preparing the managed environment.'),
    'ensuring-profile': t('device_info_phase_ensuring_profile', 'Configuring LXD profile'),
    'ensuring-container': t('device_info_phase_ensuring_container', 'Creating managed container'),
    'installing-runtime': t('device_info_phase_installing_runtime', 'Installing container runtime'),
    'pushing-agent': t('device_info_phase_pushing_agent', 'Copying Nimbus services'),
    'installing-agent-python': t('device_info_phase_installing_python', 'Installing Python dependencies'),
    'starting-agent': t('device_info_phase_starting_agent', 'Starting Nimbus agent'),
    ready: t('device_info_ready', 'Ready'),
    error: t('error', 'Error'),
  }
  return labels[state] || state || t('unknown', 'Unknown')
}

function SnapshotsTab({ containerReady }) {
  const { t } = useTranslation()
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
    return <p style={styles.muted}>{t('device_info_snapshots_not_ready', 'Container must be running and ready to manage snapshots.')}</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={styles.snapshotRow}>
        <input
          style={styles.snapInput}
          placeholder={t('device_info_snapshots_placeholder', 'Snapshot name')}
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleCreate()}
        />
        <Button variant="soft" size="sm" onClick={handleCreate} disabled={busy === 'create' || !newName.trim()} loading={busy === 'create'}>
          {busy === 'create' ? t('creating', 'Creating…') : t('create', 'Create')}
        </Button>
      </div>

      {error && <div style={styles.errorText}>{error}</div>}

      {snapshots === null && <p style={styles.muted}>{t('loading', 'Loading…')}</p>}
      {snapshots !== null && snapshots.length === 0 && (
        <p style={styles.muted}>{t('device_info_snapshots_none', 'No snapshots yet. Create one to save the container state.')}</p>
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
              {t('device_info_snapshots_restore', 'Restore')}
            </Button>
            <Button variant="danger" size="sm" onClick={() => handleDelete(snap.name)} disabled={Boolean(busy)} loading={busy === `del-${snap.name}`}>
              {busy === `del-${snap.name}` ? t('deleting', 'Deleting…') : t('delete', 'Delete')}
            </Button>
          </div>
        </div>
      ))}

      {confirmRestore && (
        <div style={styles.confirmOverlay}>
          <div style={styles.confirmCard}>
            <div style={styles.confirmTitle}>{t('device_info_snapshots_restore_title', 'Restore Snapshot')}</div>
            <p style={styles.confirmMsg}>
              {t('device_info_snapshots_restore_desc', 'Restoring {{name}} will revert the container to that state. All changes since the snapshot will be lost.', { name: confirmRestore })}
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <Button variant="secondary" size="sm" onClick={() => setConfirmRestore(null)}>{t('cancel', 'Cancel')}</Button>
              <Button variant="danger" size="sm" onClick={() => handleRestore(confirmRestore)} disabled={Boolean(busy)} loading={busy === `restore-${confirmRestore}`}>
                {busy === `restore-${confirmRestore}` ? t('restoring', 'Restoring…') : t('device_info_snapshots_restore', 'Restore')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AiModelTab() {
  const { t } = useTranslation()
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
            if (s?.pull?.status === 'ready') setMsg(t('device_info_ai_ready_msg', 'Model ready.'))
            if (s?.pull?.status === 'failed') setError(s.pull.error || t('device_info_ai_pull_failed', 'Pull failed.'))
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
    try { await pullModel(); setMsg(t('device_info_ai_pull_started', 'Model download started. This may take a while.')); await load() }
    catch (e) { setError(e.message); setBusy(null) }
  }

  async function handleEnsure() {
    setBusy('ensure'); setError(null); setMsg(null)
    try { await ensureModel(); setMsg(t('device_info_ai_verification_started', 'Model verification started.')); await load() }
    catch (e) { setError(e.message); setBusy(null) }
  }

  async function handleSelect() {
    if (!selectedModel || selectedModel === modelStatus?.model_id) return
    setBusy('select'); setError(null); setMsg(null)
    try {
      await selectModel(selectedModel)
      setMsg(t('device_info_ai_switching_msg', 'Switching model… this may take a while.'))
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

      {modelStatus === null && <p style={styles.muted}>{t('loading', 'Loading…')}</p>}
      {modelStatus !== null && (
        <>
          <div style={styles.infoTable}>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>{t('device_info_ai_provider', 'Provider')}</span>
              <span style={styles.infoValue}>{modelStatus.provider || '—'}</span>
            </div>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>{t('device_info_ai_active', 'Active Model')}</span>
              <span style={{ ...styles.infoValue, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                {friendlyModelName(currentModelId)}
              </span>
            </div>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>{t('device_info_ai_status', 'Status')}</span>
              <span style={{ ...styles.infoValue, color: modelStatus.status === 'ready' ? 'var(--color-success)' : 'var(--text-secondary)' }}>
                {modelStatus.status || '—'}
              </span>
            </div>
            {lemon && (
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Lemonade</span>
                <span style={{ ...styles.infoValue, color: lemon.reachable ? 'var(--color-success)' : 'var(--color-danger)' }}>
                  {lemon.reachable ? t('app_modal_running', 'Running') : t('device_info_not_reachable', 'Not reachable')}
                </span>
              </div>
            )}
            {isPulling && (
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>{t('device_info_ai_download_status', 'Download')}</span>
                <span style={styles.infoValue}>
                  {pull.status} {pull.percent > 0 ? `(${Math.round(pull.percent)}%)` : ''}
                  {pull.total_files > 0 ? ` — file ${pull.file_index}/${pull.total_files}` : ''}
                </span>
              </div>
            )}
          </div>

          {availableModels.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>{t('device_info_ai_change', 'Change Model')}</label>
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
                  {busy === 'select' ? t('device_info_ai_switching', 'Switching…') : selectedModelInfo?.downloaded ? t('apply', 'Apply') : t('device_info_ai_pull_apply', 'Pull & Apply')}
                </Button>
              </div>
              {isDifferent && (
                <p style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: 0, fontFamily: 'var(--font-sans)' }}>
                  {selectedModelInfo?.downloaded
                    ? t('device_info_ai_apply_desc', 'Will load the model and re-run auto-config for installed apps.')
                    : t('device_info_ai_pull_desc', 'Will download the model, then re-run auto-config for installed apps.')}
                </p>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="soft" size="sm" onClick={handleEnsure} disabled={Boolean(busy)} loading={busy === 'ensure'}>
              {busy === 'ensure' ? t('device_info_ai_verifying', 'Verifying…') : t('device_info_ai_verify_load', 'Verify / Load')}
            </Button>
            <Button variant="secondary" size="sm" onClick={handlePull} disabled={Boolean(busy)} loading={busy === 'pull'}>
              {busy === 'pull' ? t('device_info_ai_pulling', 'Pulling…') : t('device_info_ai_repull', 'Re-pull Model')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function CloudOffloadTab() {
  const { t } = useTranslation()
  const [status, setStatus] = useState(null)
  const [presets, setPresets] = useState({})
  const [providers, setProviders] = useState([])
  const [cloudModels, setCloudModels] = useState([])
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [msg, setMsg] = useState(null)

  const [customName, setCustomName] = useState('')
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customApiKey, setCustomApiKey] = useState('')

  const [enabled, setEnabled] = useState(false)
  const [cloudProvider, setCloudProvider] = useState('')
  const [cloudModel, setCloudModel] = useState('')
  const [offloadTools, setOffloadTools] = useState(false)
  const [offloadImages, setOffloadImages] = useState(false)
  const [offloadLongInput, setOffloadLongInput] = useState(false)
  const [longInputChars, setLongInputChars] = useState(4000)
  const [offloadKeywords, setOffloadKeywords] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [advancedJson, setAdvancedJson] = useState('')
  const [usage, setUsage] = useState(null)

  async function load() {
    try {
      const [s, p, provs, u] = await Promise.all([getCloudStatus(), getCloudPresets(), listCloudProviders(), getCloudUsage(14)])
      setStatus(s)
      setPresets(p)
      setProviders(provs)
      setUsage(u)
      setEnabled(Boolean(s.cloud_offload_enabled))
      setCloudProvider(s.cloud_provider || '')
      setCloudModel(s.cloud_model || '')
      const tog = s.toggles || {}
      setOffloadTools(Boolean(tog.offload_tools))
      setOffloadImages(Boolean(tog.offload_images))
      setOffloadLongInput(Boolean(tog.offload_long_input))
      setLongInputChars(tog.long_input_chars || 4000)
      setOffloadKeywords((tog.offload_keywords || []).join(', '))
      if (s.advanced_json) {
        setShowAdvanced(true)
        setAdvancedJson(s.advanced_json)
      }
    } catch (e) { setError(e.message) }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (!cloudProvider) { setCloudModels([]); return }
    getCloudProviderModels(cloudProvider).then(setCloudModels).catch(() => setCloudModels([]))
  }, [cloudProvider])

  async function handleAddPreset(slug) {
    const preset = presets[slug]
    if (!preset) return
    setBusy(`add-${slug}`); setError(null); setMsg(null)
    try {
      await addCloudProvider(slug, preset.display_name, preset.base_url, '')
      setMsg(t('cloud_offload_provider_added', 'Provider added.'))
      await load()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  async function handleAddCustom() {
    if (!customName.trim() || !customBaseUrl.trim()) return
    const slug = customName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    setBusy('add-custom'); setError(null); setMsg(null)
    try {
      await addCloudProvider(slug, customName.trim(), customBaseUrl.trim(), customApiKey)
      setCustomName(''); setCustomBaseUrl(''); setCustomApiKey('')
      setMsg(t('cloud_offload_provider_added', 'Provider added.'))
      await load()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  async function handleDeleteProvider(slug) {
    setBusy(`del-${slug}`); setError(null); setMsg(null)
    try {
      await deleteCloudProvider(slug)
      setMsg(t('cloud_offload_provider_removed', 'Provider removed.'))
      await load()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  let advancedParsed
  let advancedInvalid = false
  if (showAdvanced) {
    try { advancedParsed = JSON.parse(advancedJson) } catch { advancedInvalid = true }
    if (!advancedInvalid && (!advancedParsed || !Array.isArray(advancedParsed.candidates) || !advancedParsed.default_model)) {
      advancedInvalid = true
    }
  }

  const keywordList = offloadKeywords.split(',').map(k => k.trim()).filter(Boolean)
  const hasAnyToggle = offloadTools || offloadImages || offloadLongInput || keywordList.length > 0
  const canSave = !enabled || (showAdvanced ? !advancedInvalid : Boolean(cloudModel) && hasAnyToggle)

  async function handleSave() {
    setBusy('save'); setError(null); setMsg(null)
    try {
      await saveCloudPolicy({
        enabled,
        cloud_provider: cloudProvider || null,
        cloud_model: cloudModel || null,
        toggles: {
          offload_tools: offloadTools,
          offload_images: offloadImages,
          offload_long_input: offloadLongInput,
          long_input_chars: Number(longInputChars) || 4000,
          offload_keywords: keywordList,
        },
        advanced_json: showAdvanced ? advancedJson : null,
      })
      setMsg(t('cloud_offload_save_success', 'Cloud offload policy saved.'))
      await load()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  if (status === null) return <p style={styles.muted}>{t('loading', 'Loading…')}</p>

  const availablePresets = Object.entries(presets).filter(([slug]) => !providers.some(p => p.provider === slug))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && <div style={styles.errorText}>{error}</div>}
      {msg && <div style={{ ...styles.errorText, color: 'var(--color-success)' }}>{msg}</div>}

      <div style={styles.infoTable}>
        <div style={styles.infoRow}>
          <span style={styles.infoLabel}>{t('cloud_offload_enable', 'Enable Cloud Offload')}</span>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
        </div>
        {!enabled && (
          <div style={styles.infoRow}>
            <span style={styles.muted}>{t('cloud_offload_disabled_desc', 'All requests stay on the local model.')}</span>
          </div>
        )}
      </div>

      <div>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>
          {t('cloud_offload_provider_title', 'Cloud Provider')}
        </label>

        {providers.length > 0 && (
          <div style={{ ...styles.infoTable, marginTop: 8, marginBottom: 8 }}>
            {providers.map(p => (
              <div key={p.provider} style={styles.infoRow}>
                <span style={styles.infoValue}>{p.display_name}</span>
                <Button
                  variant="danger" size="sm" onClick={() => handleDeleteProvider(p.provider)}
                  disabled={Boolean(busy)} loading={busy === `del-${p.provider}`}
                >
                  {busy === `del-${p.provider}` ? t('deleting', 'Deleting…') : t('delete', 'Delete')}
                </Button>
              </div>
            ))}
          </div>
        )}

        {availablePresets.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {availablePresets.map(([slug, preset]) => (
              <Button
                key={slug} variant="soft" size="sm" onClick={() => handleAddPreset(slug)}
                disabled={Boolean(busy)} loading={busy === `add-${slug}`}
              >
                {t('cloud_offload_add_provider', 'Add')} {preset.display_name}
              </Button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            style={{ ...styles.snapInput, flex: 'none', width: 140 }}
            placeholder={t('cloud_offload_provider_name', 'Provider name')}
            value={customName} onChange={e => setCustomName(e.target.value)}
          />
          <input
            style={{ ...styles.snapInput, minWidth: 200 }}
            placeholder={t('cloud_offload_base_url', 'Base URL')}
            value={customBaseUrl} onChange={e => setCustomBaseUrl(e.target.value)}
          />
          <input
            style={{ ...styles.snapInput, flex: 'none', width: 140 }}
            placeholder={t('cloud_offload_api_key', 'API key')} type="password"
            value={customApiKey} onChange={e => setCustomApiKey(e.target.value)}
          />
          <Button
            variant="soft" size="sm" onClick={handleAddCustom}
            disabled={Boolean(busy) || !customName.trim() || !customBaseUrl.trim()} loading={busy === 'add-custom'}
          >
            {t('cloud_offload_add_provider', 'Add')}
          </Button>
        </div>
      </div>

      {providers.length > 0 && (
        <div>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>
            {t('cloud_offload_model_title', 'Cloud Model')}
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <select style={styles.modelSelect} value={cloudProvider} onChange={e => { setCloudProvider(e.target.value); setCloudModel('') }}>
              <option value="">—</option>
              {providers.map(p => <option key={p.provider} value={p.provider}>{p.display_name}</option>)}
            </select>
            <select style={styles.modelSelect} value={cloudModel} onChange={e => setCloudModel(e.target.value)} disabled={!cloudProvider}>
              <option value="">—</option>
              {cloudModels.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
          </div>
          {cloudProvider && cloudModels.length === 0 && (
            <p style={styles.muted}>{t('cloud_offload_no_models', 'No models discovered yet — check the API key.')}</p>
          )}
        </div>
      )}

      <div style={styles.infoTable}>
        <div style={styles.infoRow}>
          <span style={styles.infoLabel}>{t('cloud_offload_toggle_tools', 'Offload requests that use tools')}</span>
          <input type="checkbox" checked={offloadTools} onChange={e => setOffloadTools(e.target.checked)} />
        </div>
        <div style={styles.infoRow}>
          <span style={styles.infoLabel}>{t('cloud_offload_toggle_images', 'Offload requests with images')}</span>
          <input type="checkbox" checked={offloadImages} onChange={e => setOffloadImages(e.target.checked)} />
        </div>
        <div style={styles.infoRow}>
          <span style={styles.infoLabel}>{t('cloud_offload_toggle_long_input', 'Offload long inputs')}</span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="number" style={{ ...styles.snapInput, flex: 'none', width: 90 }}
              value={longInputChars} onChange={e => setLongInputChars(e.target.value)} disabled={!offloadLongInput}
            />
            <input type="checkbox" checked={offloadLongInput} onChange={e => setOffloadLongInput(e.target.checked)} />
          </div>
        </div>
        <div style={styles.infoRow}>
          <span style={styles.infoLabel}>{t('cloud_offload_toggle_keywords', 'Offload on keywords')}</span>
          <input
            style={{ ...styles.snapInput, flex: 'none', width: 220 }}
            placeholder={t('cloud_offload_keywords_placeholder', 'comma-separated keywords')}
            value={offloadKeywords} onChange={e => setOffloadKeywords(e.target.value)}
          />
        </div>
      </div>

      <div>
        <button style={styles.advancedToggle} onClick={() => setShowAdvanced(!showAdvanced)}>
          {showAdvanced ? '▾' : '▸'} {t('cloud_offload_advanced', 'Advanced: edit policy JSON')}
        </button>
        {showAdvanced && (
          <>
            <textarea
              style={styles.advancedTextarea} rows={10} value={advancedJson}
              onChange={e => setAdvancedJson(e.target.value)}
            />
            {advancedInvalid && <p style={styles.errorText}>{t('cloud_offload_advanced_invalid', 'Invalid policy JSON')}</p>}
          </>
        )}
      </div>

      <Button variant="primary" onClick={handleSave} disabled={!canSave || Boolean(busy)} loading={busy === 'save'}>
        {busy === 'save' ? t('saving', 'Saving…') : t('save', 'Save')}
      </Button>

      <div>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>
          {t('cloud_offload_usage_title', 'On-device vs. cloud')}
        </label>
        <div style={{ marginTop: 8 }}>
          {usage && usage.reachable !== false && (usage.totals.local_requests + usage.totals.cloud_requests > 0) ? (
            <>
              <UsageSplitBar local={usage.totals.local_requests} cloud={usage.totals.cloud_requests} t={t} />
              <UsageTrend daily={usage.daily} t={t} />
            </>
          ) : (
            <p style={styles.muted}>
              {usage && usage.reachable === false
                ? t('cloud_offload_usage_unreachable', 'Could not reach lemonade to measure request counts.')
                : t('cloud_offload_usage_no_data', 'No requests observed yet.')}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default function DeviceInfo({ stats, apps }) {
  const { t } = useTranslation()
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
    { id: 'overview', label: t('device_info_overview', 'Overview') },
    ...(isLxd ? [{ id: 'snapshots', label: t('device_info_snapshots', 'Snapshots') }] : []),
    { id: 'ai', label: t('device_info_ai', 'AI Model') },
    { id: 'cloud', label: t('device_info_cloud', 'Cloud Offload') },
    { id: 'logs', label: t('device_info_logs', 'Logs') },
  ]

  return (
    <div style={styles.container}>
      {setupPending && (
        <section style={styles.setupBanner}>
          <div style={styles.setupBannerTitle}>{firstSetup ? t('device_info_setup_title_setting_up', 'Nimbus is still being set up') : t('device_info_setup_title_starting', 'Nimbus is still starting')}</div>
          <div style={styles.setupBannerText}>
            {stats?.bootstrap_error
              ? `${t('device_info_setup_failed', 'Setup failed')}: ${stats.bootstrap_error}`
              : `${formatBootstrapState(stats?.bootstrap_state, t)}. ${firstSetup ? t('device_info_setup_lxd_not_ready', 'The managed LXD container is not ready for normal use yet.') : t('device_info_setup_lxd_reconnecting', 'Nimbus is reconnecting to the managed container and restoring app state.')}`}
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
            <h3 style={styles.sectionTitle}>{t('device_info_system_status', 'System Status')}</h3>
            {stats ? (
              <>
                <Gauge label={t('device_info_cpu_usage', 'CPU Usage')} value={stats.cpu_pct} color="var(--color-accent)" />
                <Gauge
                  label={t('device_info_memory_usage', 'Memory Usage')}
                  value={stats.mem_pct}
                  color="var(--color-info)"
                  subtitle={stats.mem_total_gb ? `${stats.mem_used_gb} / ${hardware?.ram_gb ?? stats.mem_total_gb} GB` : undefined}
                />
                <Gauge
                  label={t('device_info_disk_usage', 'Storage (host root)')}
                  value={stats.disk_pct}
                  color="var(--nimbus-sky-300)"
                  subtitle={stats.disk_total_gb ? `${stats.disk_used_gb} / ${stats.disk_total_gb} GB` : undefined}
                />
              </>
            ) : (
              <p style={styles.muted}>{t('loading', 'Loading…')}</p>
            )}
          </section>

          {hardware && (
            <section style={styles.section}>
              <h3 style={styles.sectionTitle}>{t('device_info_hardware_title', 'Hardware')}</h3>
              <div style={styles.infoTable}>
                {hardware.system_name && <InfoRow label={t('device_info_hardware_system', 'System')} value={hardware.system_name} />}
                {hardware.chassis_type && <InfoRow label={t('device_info_hardware_form_factor', 'Form Factor')} value={hardware.chassis_type} />}
                {hardware.cpu_model && (
                  <InfoRow
                    label={t('device_info_cpu_model', 'CPU')}
                    value={
                      hardware.cpu_cores_physical
                        ? `${hardware.cpu_model} (${hardware.cpu_cores_physical}C / ${hardware.cpu_cores_logical}T)`
                        : hardware.cpu_model
                    }
                  />
                )}
                {hardware.gpu && <InfoRow label="GPU" value={hardware.gpu} />}
                {hardware.ram_gb && <InfoRow label={t('device_info_memory', 'RAM')} value={`${hardware.ram_gb} GB`} />}
              </div>
            </section>
          )}

          <section style={styles.section}>
            <h3 style={styles.sectionTitle}>{t('device_info_apps_title', 'Apps')}</h3>
            <div style={styles.statGrid}>
              <StatTile value={installed} label={t('app_store_installed', 'Installed')} color="var(--color-info)" />
              <StatTile value={running} label={t('app_modal_running', 'Running')} color="var(--color-success)" />
              <StatTile value={updates} label={t('app_store_update_available', 'Update available')} color="var(--color-warning)" />
            </div>
          </section>

          <section style={styles.section}>
            <h3 style={styles.sectionTitle}>{t('device_info_platform_title', 'Platform')}</h3>
            <div style={styles.infoTable}>
              <InfoRow label={t('device_info_service_label', 'Service')} value={stats?.version ? `Nimbus v${stats.version}` : 'Nimbus'} />
              <InfoRow label={t('device_info_runtime_label', 'Runtime')} value={stats?.control_mode === 'lxd' ? 'SnapD + LXD' : 'Docker + LXD'} />
              <InfoRow label={t('device_info_catalog_label', 'App Catalog')} value={stats?.app_store_type === 'umbrel' ? 'Umbrel App Store' : 'Nimbus App Store'} />
              {stats?.container_name && <InfoRow label={t('device_info_managed_environment', 'Managed Container')} value={stats.container_name} />}
              {stats?.container_status && <InfoRow label={t('device_info_container_status', 'Container State')} value={stats.container_status} />}
              {stats?.container_ip && <InfoRow label={t('device_info_ip_address', 'Container IP')} value={stats.container_ip} />}
              {stats?.bootstrap_state && <InfoRow label={t('device_info_bootstrap_phase', 'Bootstrap')} value={formatBootstrapState(stats.bootstrap_state, t)} />}
              {stats?.tls_enabled && stats?.tls_fingerprint && (
                <InfoRow label={t('settings_https_fingerprint', 'TLS Fingerprint')} value={stats.tls_fingerprint} />
              )}
            </div>
            {stats?.bootstrap_error && (
              <p style={styles.errorText}>{t('device_info_bootstrap_error', 'Container bootstrap error')}: {stats.bootstrap_error}</p>
            )}
          </section>
        </>
      )}

      {activeTab === 'snapshots' && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>{t('device_info_snapshots_heading', 'Container Snapshots')}</h3>
          <SnapshotsTab containerReady={containerReady} />
        </section>
      )}

      {activeTab === 'ai' && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>{t('device_info_ai', 'AI Model')}</h3>
          <AiModelTab />
        </section>
      )}

      {activeTab === 'cloud' && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>{t('device_info_cloud', 'Cloud Offload')}</h3>
          <CloudOffloadTab />
        </section>
      )}

      {activeTab === 'logs' && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>{t('device_info_logs', 'Logs')}</h3>
          <div style={styles.logTabs}>
            <button
              style={{ ...styles.tab, ...(logSource === 'host' ? styles.tabActive : {}) }}
              onClick={() => setLogSource('host')}
            >
              {t('device_info_logs_host', 'Host')}
            </button>
            {isLxd && (
              <button
                style={{ ...styles.tab, ...(logSource === 'lxc' ? styles.tabActive : {}) }}
                onClick={() => setLogSource('lxc')}
              >
                {t('device_info_logs_container', 'Container')}
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
  usageBarTrack: { display: 'flex', height: '14px', marginBottom: '10px' },
  usageBarSegment: { transition: 'width 0.6s ease' },
  usageLegend: { display: 'flex', gap: '18px', flexWrap: 'wrap' },
  usageLegendItem: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text-secondary)' },
  usageDot: { width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block', flexShrink: 0 },
  usageTrendStrip: {
    display: 'flex', alignItems: 'flex-end', gap: '3px', height: '40px',
    background: 'var(--color-surface-1)', borderRadius: 'var(--radius-sm)', padding: '4px 6px 0',
  },
  usageTrendCol: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', minWidth: '4px', cursor: 'default' },
  usageTrendAxis: {
    display: 'flex', justifyContent: 'space-between', color: 'var(--text-tertiary)',
    fontSize: '11px', marginTop: '4px',
  },
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
  advancedToggle: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
    cursor: 'pointer',
    padding: '4px 0',
  },
  advancedTextarea: {
    width: '100%',
    marginTop: 8,
    background: 'var(--color-surface-2)',
    color: 'var(--text-primary)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-sm)',
    padding: '8px 10px',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    outline: 'none',
    resize: 'vertical',
    boxSizing: 'border-box',
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
