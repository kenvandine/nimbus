import { useState, useEffect } from 'react'
import {
  ShieldCheck, ArrowUpCircle, Network, Wifi as WifiIcon, Globe, Link2, Lock, LockKeyhole,
  KeySquare, ShieldAlert, SlidersHorizontal, KeyRound, Check,
} from 'lucide-react'

import {
  restartSystem,
  getNetworkAddresses, getWifiStatus, scanWifiNetworks, connectWifi, disconnectWifi,
  getSshStatus, listSshKeys, addSshKey, removeSshKey,
  getFirewallStatus, listFirewallRules, addFirewallRule, deleteFirewallRule,
  enableFirewall, disableFirewall,
  getDns, setDns,
  changePassword,
  getResourceLimits, setResourceLimits,
  listApiKeys, setApiKey, deleteApiKey,
  getTailscaleStatus,
} from '../api.js'
import { SettingsSection, SettingsRow } from './ui/Section.jsx'
import Button from './ui/Button.jsx'
import Badge from './ui/Badge.jsx'
import SignalBars from './ui/SignalBars.jsx'
import PasswordField from './ui/PasswordField.jsx'
import PinPad, { PinDots } from './ui/PinPad.jsx'
import { useTranslation, LanguageSelector } from '../i18n.jsx'

const STATUS_REFRESH_DELAY_MS = 3000
const STATUS_IP_RETRY_DELAY_MS = 1500

// ── Network Addresses ─────────────────────────────────────────────────────────
function NetworkAddressesPanel() {
  const { t } = useTranslation()
  const [addresses, setAddresses] = useState(null)
  useEffect(() => { getNetworkAddresses().then(setAddresses).catch(() => setAddresses([])) }, [])

  return (
    <SettingsSection icon={<Network size={16} />} title={t('settings_ip_title', 'IP Addresses')}>
      {addresses === null && <SettingsRow label={t('settings_ip_loading', 'Loading…')} />}
      {addresses !== null && addresses.length === 0 && <SettingsRow label={t('settings_ip_none', 'No network addresses found')} />}
      {addresses !== null && addresses.map((a, i) => (
        <SettingsRow key={i} label={a.interface}>
          <span style={styles.addressPill}>{a.address}</span>
        </SettingsRow>
      ))}
    </SettingsSection>
  )
}

// ── Wi-Fi ──────────────────────────────────────────────────────────────────────
function WifiPanel() {
  const { t } = useTranslation()
  const [status, setStatus] = useState(null)
  const [networks, setNetworks] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [connecting, setConnecting] = useState(null)
  const [expandedSsid, setExpandedSsid] = useState(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)

  useEffect(() => { getWifiStatus().then(setStatus).catch(() => {}) }, [])

  async function refreshWifiStatus() {
    let s = null
    try {
      s = await getWifiStatus()
      setStatus(s)
      if (s?.connected && !s.ip_address) {
        await new Promise(r => setTimeout(r, STATUS_IP_RETRY_DELAY_MS))
        s = await getWifiStatus()
        setStatus(s)
      }
    } catch {}
    return s
  }

  async function handleScan() {
    setScanning(true); setError(null)
    try { setNetworks(await scanWifiNetworks()) }
    catch (e) { setError(e.message) }
    finally { setScanning(false) }
  }

  async function handleConnect(ssid, pwd) {
    setConnecting(ssid); setError(null)
    try {
      await connectWifi(ssid, pwd || null)
      setExpandedSsid(null); setPassword('')
      setTimeout(async () => {
        await refreshWifiStatus()
        try { setNetworks(await scanWifiNetworks()) } catch {}
      }, STATUS_REFRESH_DELAY_MS)
    } catch (e) { setError(e.message) }
    finally { setConnecting(null) }
  }

  async function handleDisconnect() {
    setError(null)
    try {
      await disconnectWifi()
      const s = await refreshWifiStatus()
      if (s) setStatus(s)
      if (networks) setNetworks(await scanWifiNetworks())
    } catch (e) { setError(e.message) }
  }

  const unavailable = status && !status.available

  return (
    <SettingsSection icon={<WifiIcon size={16} />} title={t('settings_wifi_title', 'Wi-Fi')}>
      <SettingsRow
        label={
          unavailable
            ? t('settings_wifi_unavailable', 'Not available')
            : status === null
              ? t('settings_ip_loading', 'Loading…')
              : status.connected
                ? t('settings_wifi_status_connected', 'Connected to "{{ssid}}"', { ssid: status.ssid })
                : t('settings_wifi_status_disconnected', 'Not connected')
        }
        sub={unavailable && status.error ? status.error : (status?.connected && status?.ip_address ? t('settings_wifi_ip', 'IP: {{ip}}', { ip: status.ip_address }) : undefined)}
      >
        {status?.connected && <Button variant="danger" size="sm" onClick={handleDisconnect}>{t('disconnect', 'Disconnect')}</Button>}
        <Button variant="soft" size="sm" onClick={handleScan} disabled={scanning || !!unavailable} loading={scanning}>
          {scanning ? t('oobe_scanning', 'Scanning…') : t('oobe_scan', 'Scan')}
        </Button>
      </SettingsRow>
      {error && <div style={styles.errorRow}>{error}</div>}
      {networks !== null && networks.map(net => (
        <div key={net.ssid}>
          <SettingsRow
            label={
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <SignalBars strength={net.strength} />
                <span style={{ color: net.in_use ? 'var(--color-info-soft-text)' : 'var(--text-primary)' }}>
                  {net.ssid}
                  {net.secured && <Lock size={11} style={{ marginLeft: 5, opacity: 0.5, verticalAlign: -1 }} />}
                  {net.in_use && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--color-success)' }}><Check size={10} style={{ verticalAlign: -1 }} /> {t('settings_wifi_connected_status', 'connected')}</span>}
                </span>
              </span>
            }
          >
            {!net.in_use && (
              <Button
                variant="soft"
                size="sm"
                onClick={() => {
                  if (!net.secured || net.known) handleConnect(net.ssid, null)
                  else { setExpandedSsid(p => p === net.ssid ? null : net.ssid); setPassword(''); setError(null) }
                }}
                disabled={connecting === net.ssid}
                loading={connecting === net.ssid}
              >
                {connecting === net.ssid ? t('connecting', 'Connecting…') : t('connect', 'Connect')}
              </Button>
            )}
          </SettingsRow>
          {expandedSsid === net.ssid && (
            <div style={styles.passwordRow}>
              <PasswordField
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t('settings_wifi_password_placeholder', 'Password')}
                onKeyDown={e => e.key === 'Enter' && handleConnect(net.ssid, password)}
                autoFocus
              />
              <div style={{ display: 'flex', gap: '8px', width: '100%', justifyContent: 'flex-end', marginTop: '4px' }}>
                <Button variant="ghost" size="sm" onClick={() => setExpandedSsid(null)}>{t('cancel', 'Cancel')}</Button>
                <Button variant="soft" size="sm" onClick={() => handleConnect(net.ssid, password)} disabled={connecting === net.ssid || !password} loading={connecting === net.ssid}>
                  {connecting === net.ssid ? t('connecting', 'Connecting…') : t('connect', 'Connect')}
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
      {networks !== null && networks.length === 0 && <SettingsRow label={t('settings_wifi_no_networks', 'No networks found')} />}
      {networks === null && <SettingsRow label={t('settings_wifi_scan_hint', 'Press Scan to discover available networks')} />}
    </SettingsSection>
  )
}

// ── DNS ────────────────────────────────────────────────────────────────────────
function DnsPanel() {
  const { t } = useTranslation()
  const [servers, setServers] = useState(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function load() {
    try { const d = await getDns(); setServers(d.servers) } catch {}
  }
  useEffect(() => { load() }, [])

  async function handleSave() {
    const parsed = draft.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
    if (!parsed.length) return
    setBusy(true); setError(null)
    try {
      await setDns(parsed)
      setServers(parsed); setEditing(false)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  return (
    <SettingsSection icon={<Globe size={16} />} title={t('settings_dns_title', 'DNS Servers')}>
      {!editing ? (
        <SettingsRow label={t('settings_dns_resolvers', 'Upstream resolvers')} sub={servers ? servers.join(', ') : t('settings_ip_loading', 'Loading…')}>
          <Button variant="secondary" size="sm" onClick={() => { setDraft(servers?.join('\n') || ''); setEditing(true) }}>{t('edit', 'Edit')}</Button>
          <Button variant="secondary" size="sm" onClick={() => { setDraft('1.1.1.1\n1.0.0.1'); setEditing(true) }}>{t('reset', 'Reset')}</Button>
        </SettingsRow>
      ) : (
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            style={{ ...styles.input, resize: 'vertical', minHeight: 72, padding: 10, fontFamily: 'var(--font-mono)', fontSize: 12 }}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="1.1.1.1&#10;8.8.8.8"
          />
          {error && <div style={styles.errorRow}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="soft" size="sm" onClick={handleSave} disabled={busy} loading={busy}>{busy ? t('saving', 'Saving…') : t('save', 'Save')}</Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>{t('cancel', 'Cancel')}</Button>
          </div>
        </div>
      )}
    </SettingsSection>
  )
}

// ── SSH Keys ───────────────────────────────────────────────────────────────────
function SshPanel() {
  const { t } = useTranslation()
  const [keys, setKeys] = useState(null)
  const [newKey, setNewKey] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  async function load() {
    try { setKeys(await listSshKeys()) } catch (e) { setError(e.message) }
  }
  useEffect(() => { load() }, [])

  async function handleAdd() {
    if (!newKey.trim()) return
    setBusy('add'); setError(null)
    try { await addSshKey(newKey.trim()); setNewKey(''); await load() }
    catch (e) { setError(e.message) }
    finally { setBusy(null) }
  }

  async function handleRemove(fp) {
    setBusy(fp); setError(null)
    try { await removeSshKey(fp); await load() }
    catch (e) { setError(e.message) }
    finally { setBusy(null) }
  }

  return (
    <SettingsSection icon={<KeySquare size={16} />} title={t('settings_ssh_title', 'SSH Access')}>
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <textarea
          style={{ ...styles.input, resize: 'vertical', minHeight: 64, padding: 10, fontFamily: 'var(--font-mono)', fontSize: 11 }}
          value={newKey}
          onChange={e => setNewKey(e.target.value)}
          placeholder={t('settings_ssh_placeholder', 'ssh-rsa AAAA… or ssh-ed25519 AAAA…')}
        />
        {error && <div style={styles.errorRow}>{error}</div>}
        <Button variant="soft" size="sm" onClick={handleAdd} disabled={busy === 'add' || !newKey.trim()} loading={busy === 'add'} style={{ alignSelf: 'flex-end' }}>
          {busy === 'add' ? t('adding', 'Adding…') : t('settings_ssh_btn', 'Add Key')}
        </Button>
      </div>
      {keys !== null && keys.length === 0 && <SettingsRow label={t('settings_ssh_none', 'No authorized keys')} />}
      {keys !== null && keys.map(k => (
        <SettingsRow
          key={k.fingerprint}
          label={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{k.fingerprint}</span>}
          sub={`${k.type}${k.comment ? ` — ${k.comment}` : ''}`}
        >
          <Button variant="danger" size="sm" onClick={() => handleRemove(k.fingerprint)} disabled={!!busy} loading={busy === k.fingerprint}>{t('remove', 'Remove')}</Button>
        </SettingsRow>
      ))}
    </SettingsSection>
  )
}

// ── Firewall ───────────────────────────────────────────────────────────────────
function FirewallPanel() {
  const { t } = useTranslation()
  const [fwStatus, setFwStatus] = useState(null)
  const [rules, setRules] = useState(null)
  const [newPort, setNewPort] = useState('')
  const [newProto, setNewProto] = useState('tcp')
  const [newAction, setNewAction] = useState('allow')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  async function load() {
    try {
      const [s, r] = await Promise.all([getFirewallStatus(), listFirewallRules()])
      setFwStatus(s); setRules(r)
    } catch (e) { setError(e.message) }
  }
  useEffect(() => { load() }, [])

  async function handleToggle() {
    setBusy('toggle'); setError(null)
    try {
      if (fwStatus?.enabled) await disableFirewall()
      else await enableFirewall()
      await load()
    } catch (e) { setError(e.message) }
    finally { setBusy(null) }
  }

  async function handleAdd() {
    const port = parseInt(newPort, 10)
    if (!port || port < 1 || port > 65535) { setError('Invalid port'); return }
    setBusy('add'); setError(null)
    try { await addFirewallRule(port, newProto, newAction); setNewPort(''); await load() }
    catch (e) { setError(e.message) }
    finally { setBusy(null) }
  }

  async function handleDelete(number) {
    setBusy(`del-${number}`); setError(null)
    try { await deleteFirewallRule(number); await load() }
    catch (e) { setError(e.message) }
    finally { setBusy(null) }
  }

  return (
    <SettingsSection icon={<ShieldAlert size={16} />} title={t('settings_firewall_title', 'Firewall (UFW)')}>
      <SettingsRow
        label={t('settings_firewall_status', 'Firewall status')}
        sub={fwStatus === null ? t('settings_ip_loading', 'Loading…') : fwStatus.enabled ? t('settings_firewall_active', 'Active — traffic is filtered') : t('settings_firewall_inactive', 'Inactive — all traffic allowed')}
      >
        <Button variant="soft" size="sm" onClick={handleToggle} disabled={busy === 'toggle'} loading={busy === 'toggle'}>
          {fwStatus?.enabled ? t('disable', 'Disable') : t('enable', 'Enable')}
        </Button>
      </SettingsRow>

      <div style={{ padding: '10px 16px 4px', display: 'flex', gap: 8, alignItems: 'center' }}>
        <input style={{ ...styles.input, width: 80, padding: '6px 10px' }} placeholder={t('settings_firewall_port_placeholder', 'Port')} value={newPort}
          onChange={e => setNewPort(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()} />
        <select style={styles.select} value={newProto} onChange={e => setNewProto(e.target.value)}>
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
        </select>
        <select style={styles.select} value={newAction} onChange={e => setNewAction(e.target.value)}>
          <option value="allow">{t('settings_firewall_action_allow', 'Allow')}</option>
          <option value="deny">{t('settings_firewall_action_deny', 'Deny')}</option>
          <option value="reject">{t('settings_firewall_action_reject', 'Reject')}</option>
        </select>
        <Button variant="soft" size="sm" onClick={handleAdd} disabled={busy === 'add' || !newPort} loading={busy === 'add'}>
          {busy === 'add' ? t('adding', 'Adding…') : t('settings_firewall_add_btn', 'Add Rule')}
        </Button>
      </div>
      {error && <div style={styles.errorRow}>{error}</div>}
      {rules !== null && rules.length === 0 && <SettingsRow label={t('settings_firewall_none', 'No rules configured')} />}
      {rules !== null && rules.map(r => (
        <SettingsRow key={r.number} label={r.to} sub={`${r.action} from ${r.from}`}>
          <Button variant="danger" size="sm" onClick={() => handleDelete(r.number)} disabled={!!busy}>{t('delete', 'Delete')}</Button>
        </SettingsRow>
      ))}
    </SettingsSection>
  )
}

// ── Change Password ────────────────────────────────────────────────────────────
function ChangePasswordPanel() {
  const { t } = useTranslation()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [error, setError] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    if (next !== confirm) { setError(t('settings_password_mismatch', 'New passwords do not match')); return }
    setBusy(true); setError(null); setMsg(null)
    try {
      await changePassword(current, next)
      setCurrent(''); setNext(''); setConfirm('')
      setMsg(t('settings_password_success', 'Password changed successfully.'))
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  return (
    <SettingsSection icon={<Lock size={16} />} title={t('settings_password_title', 'Change Password')}>
      <form onSubmit={handleSubmit} style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input type="password" placeholder={t('settings_password_current', 'Current password')} value={current}
          onChange={e => setCurrent(e.target.value)} style={styles.input} autoComplete="current-password" />
        <PasswordField placeholder={t('settings_password_new', 'New password (min 8 chars)')} value={next}
          onChange={e => setNext(e.target.value)} autoComplete="new-password" />
        <PasswordField placeholder={t('settings_password_confirm', 'Confirm new password')} value={confirm}
          onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
        {error && <div style={styles.errorRow}>{error}</div>}
        {msg && <div style={{ ...styles.errorRow, color: 'var(--color-success)' }}>{msg}</div>}
        <Button type="submit" variant="soft" size="sm" disabled={busy || !current || !next || !confirm} loading={busy} style={{ alignSelf: 'flex-start' }}>
          {busy ? t('settings_password_btn_busy', 'Changing…') : t('settings_password_btn', 'Change Password')}
        </Button>
      </form>
    </SettingsSection>
  )
}

// ── Screen Lock PIN ──────────────────────────────────────────────────────────
const PIN_LENGTH = 4

function ScreenLockPanel() {
  const { t } = useTranslation()
  const [hasPin, setHasPin] = useState(() => Boolean(localStorage.getItem('nimbus_lock_pin')))
  const [mode, setMode] = useState('idle') // idle | set | confirm
  const [pin, setPin] = useState('')
  const [firstPin, setFirstPin] = useState('')
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(null)

  function advance(entered) {
    if (mode === 'set') {
      setFirstPin(entered); setPin(''); setMode('confirm'); setError(null)
    } else if (mode === 'confirm') {
      if (entered === firstPin) {
        localStorage.setItem('nimbus_lock_pin', entered)
        setHasPin(true); setMode('idle'); setPin(''); setFirstPin(''); setError(null)
        setSaved(t('settings_pin_success_saved', 'PIN saved — screen lock is now active.')); setTimeout(() => setSaved(null), 3000)
      } else {
        setError(t('oobe_pin_mismatch', 'PINs did not match — try again')); setPin(''); setMode('set'); setFirstPin('')
      }
    }
  }

  function handleRemove() {
    localStorage.removeItem('nimbus_lock_pin')
    setHasPin(false); setMode('idle'); setPin(''); setFirstPin('')
    setSaved(t('settings_pin_success_removed', 'PIN removed — screen lock disabled.')); setTimeout(() => setSaved(null), 3000)
  }

  function handleCancel() {
    setMode('idle'); setPin(''); setFirstPin(''); setError(null)
  }

  return (
    <SettingsSection icon={<LockKeyhole size={16} />} title={t('settings_pin_title', 'Screen Lock PIN')}>
      {mode === 'idle' ? (
        <>
          <SettingsRow
            label={t('settings_pin_title', 'Screen Lock PIN')}
            sub={hasPin ? t('settings_pin_status_has', 'A 4-digit PIN is required after idle timeout.') : t('settings_pin_status_none', 'No PIN set — screen will not lock on idle.')}
          >
            <Button variant="soft" size="sm" onClick={() => { setMode('set'); setPin(''); setError(null) }}>
              {hasPin ? t('settings_pin_btn_change', 'Change') : t('settings_pin_btn_set', 'Set PIN')}
            </Button>
            {hasPin && <Button variant="danger" size="sm" onClick={handleRemove}>{t('remove', 'Remove')}</Button>}
          </SettingsRow>
          {saved && (
            <div style={{ padding: '6px 16px 10px', fontSize: 12, color: 'var(--color-success)', fontFamily: 'var(--font-sans)' }}>
              <Check size={12} style={{ verticalAlign: -1, marginRight: 4 }} />{saved}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '12px 16px 16px' }}>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500, fontFamily: 'var(--font-sans)' }}>
              {mode === 'set' ? t('settings_pin_prompt_new', 'Enter a new 4-digit PIN') : t('settings_pin_prompt_confirm', 'Confirm your PIN')}
            </div>
            {error && <div style={{ fontSize: 12, color: 'var(--color-danger)', fontFamily: 'var(--font-sans)' }}>{error}</div>}
            <PinDots length={PIN_LENGTH} value={pin} size={12} />
            <PinPad value={pin} onChange={setPin} length={PIN_LENGTH} onComplete={advance} size={54} />
          </div>
          <div style={{ padding: '0 16px 14px', display: 'flex', justifyContent: 'center' }}>
            <Button variant="ghost" size="sm" onClick={handleCancel}>{t('cancel', 'Cancel')}</Button>
          </div>
        </>
      )}
    </SettingsSection>
  )
}

// ── Resource Limits ─────────────────────────────────────────────────────────
function ResourceLimitsPanel({ stats }) {
  const { t } = useTranslation()
  const [limits, setLimits] = useState(null)
  const [cpu, setCpu] = useState('')
  const [mem, setMem] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [error, setError] = useState(null)

  const isLxd = stats?.control_mode === 'lxd'
  const containerReady = isLxd && stats?.container_bootstrapped

  async function load() {
    if (!containerReady) return
    try {
      const d = await getResourceLimits()
      setLimits(d)
      setCpu(d.cpu_cores != null ? String(d.cpu_cores) : '')
      setMem(d.memory_mb != null ? String(d.memory_mb) : '')
    } catch {}
  }
  useEffect(() => { load() }, [containerReady])

  async function handleSave() {
    setBusy(true); setError(null); setMsg(null)
    try {
      await setResourceLimits(
        cpu ? parseInt(cpu, 10) : null,
        mem ? parseInt(mem, 10) : null,
      )
      setMsg(t('settings_resources_success', 'Resource limits updated.'))
      await load()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  if (!isLxd) return null

  return (
    <SettingsSection icon={<SlidersHorizontal size={16} />} title={t('settings_resources_title', 'Container Resource Limits')}>
      {!containerReady ? (
        <SettingsRow label={t('settings_resources_not_ready', 'Container must be ready to configure resource limits.')} />
      ) : (
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <label style={{ color: 'var(--text-tertiary)', fontSize: 12, width: 90, fontFamily: 'var(--font-sans)' }}>{t('settings_resources_cpu', 'CPU cores')}</label>
            <input style={{ ...styles.input, width: 80, padding: '6px 10px' }} placeholder={t('settings_resources_auto', 'auto')}
              value={cpu} onChange={e => setCpu(e.target.value.replace(/\D/g, ''))} />
            <span style={{ color: 'var(--text-disabled)', fontSize: 11, fontFamily: 'var(--font-sans)' }}>{t('settings_resources_cpu_hint', 'leave blank to use all')}</span>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <label style={{ color: 'var(--text-tertiary)', fontSize: 12, width: 90, fontFamily: 'var(--font-sans)' }}>{t('settings_resources_mem', 'Memory (MB)')}</label>
            <input style={{ ...styles.input, width: 100, padding: '6px 10px' }} placeholder={t('settings_resources_auto', 'auto')}
              value={mem} onChange={e => setMem(e.target.value.replace(/\D/g, ''))} />
            <span style={{ color: 'var(--text-disabled)', fontSize: 11, fontFamily: 'var(--font-sans)' }}>{t('settings_resources_mem_hint', 'e.g. 4096 for 4 GB')}</span>
          </div>
          {limits && (
            <div style={{ color: 'var(--text-disabled)', fontSize: 11, fontFamily: 'var(--font-sans)' }}>
              {t('settings_resources_current', 'Current: {{cpu}}, {{mem}}', {
                cpu: limits.cpu_cores != null ? t('settings_resources_current_cpu_cores', '{{cores}} vCPU', { cores: limits.cpu_cores }) : t('settings_resources_current_unlimited_cpu', 'unlimited CPU'),
                mem: limits.memory_mb != null ? t('settings_resources_current_mem_mb', '{{mb}} MB RAM', { mb: limits.memory_mb }) : t('settings_resources_current_unlimited_mem', 'unlimited RAM'),
              })}
            </div>
          )}
          {error && <div style={styles.errorRow}>{error}</div>}
          {msg && <div style={{ ...styles.errorRow, color: 'var(--color-success)' }}>{msg}</div>}
          <Button variant="soft" size="sm" onClick={handleSave} disabled={busy} loading={busy} style={{ alignSelf: 'flex-start' }}>
            {busy ? t('saving', 'Saving…') : t('settings_resources_apply', 'Apply Limits')}
          </Button>
        </div>
      )}
    </SettingsSection>
  )
}

// ── API Keys ───────────────────────────────────────────────────────────────────
function ApiKeysPanel() {
  const { t } = useTranslation()
  const [keys, setKeys] = useState(null)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  const [msg, setMsg] = useState(null)

  async function load() {
    try { setKeys(await listApiKeys()) } catch (e) { setError(e.message) }
  }
  useEffect(() => { load() }, [])

  async function handleSave() {
    if (!name.trim() || !value.trim()) { setError(t('settings_api_error_required', 'Name and value are required')); return }
    setBusy('save'); setError(null); setMsg(null)
    try { await setApiKey(name.trim(), value.trim()); setName(''); setValue(''); setMsg(t('settings_api_success', 'Key saved.')); await load() }
    catch (e) { setError(e.message) }
    finally { setBusy(null) }
  }

  async function handleDelete(keyName) {
    setBusy(keyName); setError(null); setMsg(null)
    try { await deleteApiKey(keyName); await load() }
    catch (e) { setError(e.message) }
    finally { setBusy(null) }
  }

  return (
    <SettingsSection icon={<KeyRound size={16} />} title={t('settings_api_title', 'API Keys')}>
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...styles.input, width: 120 }} placeholder={t('settings_api_name_placeholder', 'Key name')} value={name}
            onChange={e => setName(e.target.value)} />
          <input style={{ ...styles.input, flex: 1 }} placeholder={t('settings_api_value_placeholder', 'Value (e.g. sk-…)')} value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()} />
          <Button variant="soft" size="sm" onClick={handleSave} disabled={busy === 'save' || !name.trim() || !value.trim()} loading={busy === 'save'}>
            {busy === 'save' ? t('saving', 'Saving…') : t('save', 'Save')}
          </Button>
        </div>
        {error && <div style={styles.errorRow}>{error}</div>}
        {msg && <div style={{ ...styles.errorRow, color: 'var(--color-success)' }}>{msg}</div>}
      </div>
      {keys !== null && keys.length === 0 && <SettingsRow label={t('settings_api_none', 'No API keys stored')} />}
      {keys !== null && keys.map(k => (
        <SettingsRow key={k.name} label={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{k.name}</span>} sub={k.hint}>
          <Button variant="danger" size="sm" onClick={() => handleDelete(k.name)} disabled={!!busy} loading={busy === k.name}>
            {busy === k.name ? t('deleting', 'Deleting…') : t('delete', 'Delete')}
          </Button>
        </SettingsRow>
      ))}
    </SettingsSection>
  )
}

// ── Tailscale ─────────────────────────────────────────────────────────────────
function TailscalePanel() {
  const { t } = useTranslation()
  const [status, setStatus] = useState(null)

  async function load() {
    try { setStatus(await getTailscaleStatus()) } catch { setStatus({ available: false, connected: false }) }
  }

  useEffect(() => { load() }, [])

  // Poll every 4 s while the panel is open so status updates after tailscale connects
  useEffect(() => {
    const id = setInterval(load, 4000)
    return () => clearInterval(id)
  }, [])

  function openWebClient() {
    window.open('/api/tailscale/webclient/', '_blank', 'noopener,noreferrer')
  }

  function openDirectWebClient() {
    if (status?.webclient_url) window.open(status.webclient_url, '_blank', 'noopener,noreferrer')
  }

  const connected = status?.connected
  const ip = status?.tailscale_ip

  return (
    <SettingsSection icon={<Link2 size={16} />} title={t('settings_tailscale_title', 'Tailscale')}>
      <SettingsRow
        label={status === null ? t('settings_ip_loading', 'Loading…') : connected ? t('settings_tailscale_connected', 'Connected to tailnet') : t('settings_tailscale_disconnected', 'Not connected')}
        sub={connected && ip ? t('settings_tailscale_ip', 'Tailscale IP: {{ip}}', { ip }) : t('settings_tailscale_hint', 'Join your tailnet to access this device remotely')}
      >
        <Badge tone={connected ? 'success' : 'danger'}>{connected ? t('settings_tailscale_badge_connected', 'Connected') : t('settings_tailscale_badge_offline', 'Offline')}</Badge>
      </SettingsRow>

      {!connected && (
        <div style={{ padding: '10px 16px 12px', borderBottom: '1px solid var(--color-border-subtle)' }}>
          <div style={styles.itemSub}>
            {t('settings_tailscale_instructions', 'To connect this device to your tailnet, open the Tailscale web client below and sign in.')}
          </div>
        </div>
      )}

      <SettingsRow label={t('settings_tailscale_webclient_title', 'Tailscale Web Client')} sub={t('settings_tailscale_webclient_desc', 'Manage tailscale settings, routes, and exit nodes')}>
        <Button variant="soft" size="sm" onClick={openWebClient}>{t('settings_tailscale_webclient_open', 'Open')}</Button>
      </SettingsRow>

      {connected && ip && (
        <SettingsRow label={t('settings_tailscale_remote_client_title', 'Remote Web Client')} sub={t('settings_tailscale_remote_client_desc', 'Access from any tailnet device at {{ip}}:5252', { ip })}>
          <Button variant="secondary" size="sm" onClick={openDirectWebClient}>{t('settings_tailscale_remote_client_open', 'Open (port 5252)')}</Button>
        </SettingsRow>
      )}
    </SettingsSection>
  )
}

// ── Main Settings Component ────────────────────────────────────────────────────
export default function Settings({ stats, onRefresh }) {
  const { t } = useTranslation()
  const [busyAction, setBusyAction] = useState(null)
  const [localMessage, setLocalMessage] = useState(null)

  const powerSupported = Boolean(stats?.device_management_available)
  const isLxd = stats?.control_mode === 'lxd'

  async function handleRestart() {
    setBusyAction('restart'); setLocalMessage(null)
    try { await restartSystem(); setLocalMessage(t('settings_system_restart_success_msg', 'Restart requested.')) }
    catch (e) { setLocalMessage(e.message) }
    finally { setBusyAction(null) }
  }

  return (
    <div style={styles.container}>
      {/* Language */}
      <SettingsSection icon={<Globe size={16} />} title={t('language', 'Language')}>
        <SettingsRow label={t('language_select', 'Select Language')}>
          <LanguageSelector />
        </SettingsRow>
      </SettingsSection>

      {/* HTTPS Certificate */}
      <SettingsSection icon={<ShieldCheck size={16} />} title={t('settings_https_title', 'HTTPS Certificate')}>
        <SettingsRow label={t('settings_https_trust', 'Trust Nimbus CA')} sub={t('settings_https_desc', 'Install on each device to remove the HTTPS warning')}>
          <a href="/api/system/ca-cert" download="nimbus-ca.crt" style={styles.btnDownload}>{t('settings_https_download', 'Download')}</a>
        </SettingsRow>
        {stats?.tls_fingerprint && (
          <SettingsRow label={t('settings_https_fingerprint', 'Fingerprint')}>
            <span style={{ ...styles.addressPill, fontSize: 10, maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {stats.tls_fingerprint}
            </span>
          </SettingsRow>
        )}
        <SettingsRow label={t('settings_https_ios_macos', 'iOS / macOS')}><span style={styles.pillInfo}>{t('settings_https_ios_macos_desc', 'Download → open → Settings → trust')}</span></SettingsRow>
        <SettingsRow label={t('settings_https_android', 'Android')}><span style={styles.pillInfo}>{t('settings_https_android_desc', 'Settings → Security → Install cert')}</span></SettingsRow>
        <SettingsRow label={t('settings_https_linux', 'Linux')}><span style={styles.pillInfo}>{t('settings_https_linux_desc', 'cp nimbus-ca.crt /usr/local/share/ca-certificates/ && update-ca-certificates')}</span></SettingsRow>
      </SettingsSection>

      {/* System Updates */}
      <SettingsSection icon={<ArrowUpCircle size={16} />} title={t('settings_system_title', 'System')}>
        <SettingsRow label={t('settings_system_auto_refresh', 'Snap auto-refresh')} sub={t('settings_system_auto_desc', "Nimbus and its dependencies update automatically on snapd's schedule. No manual trigger needed.")}>
          <Badge tone="success">{t('settings_system_auto_badge', 'Auto')}</Badge>
        </SettingsRow>
        {stats?.version && (
          <SettingsRow label={t('version', 'Version')}><span style={styles.addressPill}>v{stats.version}</span></SettingsRow>
        )}
        <SettingsRow label={t('settings_system_restart', 'Restart system')} sub={t('settings_system_restart_desc', 'Reboot the device')}>
          <Button variant="soft" size="sm" onClick={handleRestart} disabled={!powerSupported || busyAction === 'restart'} loading={busyAction === 'restart'}>
            {busyAction === 'restart' ? t('settings_system_restart_busy', 'Restarting…') : t('restart', 'Restart')}
          </Button>
        </SettingsRow>
        {localMessage && (
          <div style={{ padding: '8px 16px', color: 'var(--text-tertiary)', fontSize: 12, fontFamily: 'var(--font-sans)' }}>{localMessage}</div>
        )}
      </SettingsSection>

      <NetworkAddressesPanel />
      <WifiPanel />
      <DnsPanel />
      <TailscalePanel />
      <ChangePasswordPanel />
      <ScreenLockPanel />
      <SshPanel />
      {isLxd && <FirewallPanel />}
      <ResourceLimitsPanel stats={stats} />
      <ApiKeysPanel />
    </div>
  )
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', gap: '20px', fontFamily: 'var(--font-sans)' },
  errorRow: { color: 'var(--color-danger)', fontSize: '12px', padding: '0 2px', fontFamily: 'var(--font-sans)' },
  btnDownload: {
    background: 'var(--color-accent-soft-bg)', color: 'var(--color-accent-soft-text)',
    border: '1px solid var(--color-accent-soft-border)', borderRadius: 'var(--radius-sm)',
    padding: '6px 14px', fontSize: '12px', fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap',
    fontFamily: 'var(--font-sans)',
  },
  pillInfo: {
    background: 'var(--color-surface-3)', color: 'var(--text-tertiary)',
    fontSize: '10px', fontWeight: 500, padding: '3px 8px', borderRadius: 'var(--radius-sm)',
    fontFamily: 'var(--font-mono)', maxWidth: '55%', textAlign: 'right',
  },
  addressPill: {
    background: 'var(--color-accent-soft-bg)', color: 'var(--color-accent-soft-text)',
    fontSize: '12px', fontWeight: 500, padding: '3px 10px', borderRadius: 'var(--radius-sm)',
    fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap',
  },
  itemSub: { color: 'var(--text-tertiary)', fontSize: '11px', fontFamily: 'var(--font-sans)' },
  passwordRow: {
    display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '8px',
    padding: '8px 16px 12px', borderBottom: '1px solid var(--color-border-subtle)',
    background: 'var(--color-surface-1)',
  },
  input: {
    background: 'var(--color-surface-2)', border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-sm)', padding: '7px 12px', color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)', fontSize: '13px', outline: 'none', boxSizing: 'border-box', width: '100%',
  },
  select: {
    background: 'var(--color-surface-2)', border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-sm)', padding: '7px 10px', color: 'var(--text-secondary)',
    fontFamily: 'var(--font-sans)', fontSize: '12px', outline: 'none', cursor: 'pointer',
  },
}
