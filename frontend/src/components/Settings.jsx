import { useState, useEffect } from 'react'

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

const STATUS_REFRESH_DELAY_MS = 3000
const STATUS_IP_RETRY_DELAY_MS = 1500

function SignalBars({ strength }) {
  const bars = 4
  const filled = Math.ceil((strength / 100) * bars)
  return (
    <span style={{ display: 'inline-flex', gap: '2px', alignItems: 'flex-end', height: '14px' }}>
      {Array.from({ length: bars }, (_, i) => (
        <span key={i} style={{
          width: '3px', height: `${5 + i * 3}px`, borderRadius: '1px',
          background: i < filled ? 'rgba(129,212,250,0.85)' : 'rgba(255,255,255,0.15)',
        }} />
      ))}
    </span>
  )
}

function SectionWrap({ icon, title, children }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionIcon}>{icon}</span>
        <span style={styles.sectionTitle}>{title}</span>
      </div>
      <div style={styles.itemList}>{children}</div>
    </div>
  )
}

function Row({ label, sub, children }) {
  return (
    <div style={styles.item}>
      <div>
        <div style={styles.itemLabel}>{label}</div>
        {sub && <div style={styles.itemSub}>{sub}</div>}
      </div>
      <div style={styles.itemActions}>{children}</div>
    </div>
  )
}

// ── Network Addresses ─────────────────────────────────────────────────────────
function NetworkAddressesPanel() {
  const [addresses, setAddresses] = useState(null)
  useEffect(() => { getNetworkAddresses().then(setAddresses).catch(() => setAddresses([])) }, [])

  return (
    <SectionWrap icon="🌐" title="IP Addresses">
      {addresses === null && <div style={styles.item}><span style={styles.itemLabel}>Loading…</span></div>}
      {addresses !== null && addresses.length === 0 && <div style={styles.item}><span style={styles.itemLabel}>No network addresses found</span></div>}
      {addresses !== null && addresses.map((a, i) => (
        <div key={i} style={styles.item}>
          <div style={styles.itemLabel}>{a.interface}</div>
          <span style={styles.addressPill}>{a.address}</span>
        </div>
      ))}
    </SectionWrap>
  )
}

// ── Wi-Fi ──────────────────────────────────────────────────────────────────────
function WifiPanel() {
  const [status, setStatus] = useState(null)
  const [networks, setNetworks] = useState(null)
  const [scanning, setScanning] = useState(false)
  const [connecting, setConnecting] = useState(null)
  const [expandedSsid, setExpandedSsid] = useState(null)
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
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
    <SectionWrap icon="📶" title="Wi-Fi">
      <div style={{ ...styles.item, justifyContent: 'space-between' }}>
        <div>
          <div style={styles.itemLabel}>
            {unavailable ? 'Not available' : status === null ? 'Loading…'
              : status.connected ? `Connected to "${status.ssid}"` : 'Not connected'}
          </div>
          {unavailable && status.error && <div style={styles.itemSub}>{status.error}</div>}
          {status?.connected && status?.ip_address && <div style={styles.itemSub}>IP: {status.ip_address}</div>}
        </div>
        <div style={styles.itemActions}>
          {status?.connected && <button style={styles.btnDanger} onClick={handleDisconnect}>Disconnect</button>}
          <button style={{ ...styles.btnPrimary, ...(scanning ? styles.btnDisabled : {}) }}
            onClick={handleScan} disabled={scanning || !!unavailable}>
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>
      </div>
      {error && <div style={styles.errorRow}>{error}</div>}
      {networks !== null && networks.map(net => (
        <div key={net.ssid}>
          <div style={styles.item}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <SignalBars strength={net.strength} />
              <span style={{ ...styles.itemLabel, color: net.in_use ? 'rgba(129,212,250,0.9)' : undefined }}>
                {net.ssid}
                {net.secured && <span style={{ marginLeft: 5, opacity: 0.5 }}>🔒</span>}
                {net.in_use && <span style={{ marginLeft: 6, fontSize: 10, color: 'rgba(129,199,132,0.9)' }}>✓ connected</span>}
              </span>
            </div>
            {!net.in_use && (
              <button style={{ ...styles.btnPrimary, ...(connecting === net.ssid ? styles.btnDisabled : {}) }}
                onClick={() => {
                  if (!net.secured || net.known) handleConnect(net.ssid, null)
                  else { setExpandedSsid(p => p === net.ssid ? null : net.ssid); setPassword(''); setShowPw(false); setError(null) }
                }} disabled={connecting === net.ssid}>
                {connecting === net.ssid ? 'Connecting…' : 'Connect'}
              </button>
            )}
          </div>
          {expandedSsid === net.ssid && (
            <div style={styles.passwordRow}>
              <div style={{ position: 'relative', width: '100%' }}>
                <input type={showPw ? 'text' : 'password'} placeholder="Password" value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleConnect(net.ssid, password)}
                  style={styles.input} autoFocus />
                <button style={styles.showPwBtn} onClick={() => setShowPw(p => !p)} tabIndex={-1}>
                  {showPw ? '🙈' : '👁'}
                </button>
              </div>
              <div style={{ display: 'flex', gap: '8px', width: '100%', justifyContent: 'flex-end', marginTop: '4px' }}>
                <button style={styles.btnCancel} onClick={() => setExpandedSsid(null)}>Cancel</button>
                <button style={{ ...styles.btnPrimary, ...(connecting === net.ssid || !password ? styles.btnDisabled : {}) }}
                  onClick={() => handleConnect(net.ssid, password)} disabled={connecting === net.ssid || !password}>
                  {connecting === net.ssid ? 'Connecting…' : 'Connect'}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      {networks !== null && networks.length === 0 && <div style={styles.item}><span style={styles.itemLabel}>No networks found</span></div>}
      {networks === null && <div style={styles.item}><span style={styles.itemLabel}>Press Scan to discover available networks</span></div>}
    </SectionWrap>
  )
}

// ── DNS ────────────────────────────────────────────────────────────────────────
function DnsPanel() {
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
    <SectionWrap icon="🌍" title="DNS Servers">
      {!editing ? (
        <div style={styles.item}>
          <div>
            <div style={styles.itemLabel}>Upstream resolvers</div>
            <div style={styles.itemSub}>{servers ? servers.join(', ') : 'Loading…'}</div>
          </div>
          <div style={styles.itemActions}>
            <button style={styles.btnSecondary} onClick={() => { setDraft(servers?.join('\n') || ''); setEditing(true) }}>
              Edit
            </button>
            <button style={styles.btnSecondary} onClick={() => { setDraft('1.1.1.1\n1.0.0.1'); setEditing(true) }}>
              Reset
            </button>
          </div>
        </div>
      ) : (
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            style={{ ...styles.input, resize: 'vertical', minHeight: 72, padding: 10, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="1.1.1.1&#10;8.8.8.8"
          />
          {error && <div style={styles.errorRow}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={{ ...styles.btnPrimary, ...(busy ? styles.btnDisabled : {}) }} onClick={handleSave} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button style={styles.btnCancel} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </SectionWrap>
  )
}

// ── SSH Keys ───────────────────────────────────────────────────────────────────
function SshPanel() {
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
    <SectionWrap icon="🔑" title="SSH Access">
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <textarea
          style={{ ...styles.input, resize: 'vertical', minHeight: 64, padding: 10, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}
          value={newKey}
          onChange={e => setNewKey(e.target.value)}
          placeholder="ssh-rsa AAAA… or ssh-ed25519 AAAA…"
        />
        {error && <div style={styles.errorRow}>{error}</div>}
        <button style={{ ...styles.btnPrimary, alignSelf: 'flex-end', ...(busy === 'add' ? styles.btnDisabled : {}) }}
          onClick={handleAdd} disabled={busy === 'add' || !newKey.trim()}>
          {busy === 'add' ? 'Adding…' : 'Add Key'}
        </button>
      </div>
      {keys !== null && keys.length === 0 && (
        <div style={styles.item}><span style={styles.itemLabel}>No authorized keys</span></div>
      )}
      {keys !== null && keys.map(k => (
        <div key={k.fingerprint} style={styles.item}>
          <div style={{ minWidth: 0 }}>
            <div style={{ ...styles.itemLabel, fontFamily: 'ui-monospace, monospace', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {k.fingerprint}
            </div>
            <div style={styles.itemSub}>{k.type}{k.comment ? ` — ${k.comment}` : ''}</div>
          </div>
          <button style={{ ...styles.btnDanger, ...(busy === k.fingerprint ? styles.btnDisabled : {}) }}
            onClick={() => handleRemove(k.fingerprint)} disabled={!!busy}>
            Remove
          </button>
        </div>
      ))}
    </SectionWrap>
  )
}

// ── Firewall ───────────────────────────────────────────────────────────────────
function FirewallPanel() {
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
    <SectionWrap icon="🛡️" title="Firewall (UFW)">
      <div style={styles.item}>
        <div>
          <div style={styles.itemLabel}>Firewall status</div>
          <div style={styles.itemSub}>{fwStatus === null ? 'Loading…' : fwStatus.enabled ? 'Active — traffic is filtered' : 'Inactive — all traffic allowed'}</div>
        </div>
        <button style={{ ...styles.btnPrimary, ...(busy === 'toggle' ? styles.btnDisabled : {}) }}
          onClick={handleToggle} disabled={busy === 'toggle'}>
          {fwStatus?.enabled ? 'Disable' : 'Enable'}
        </button>
      </div>

      <div style={{ padding: '10px 16px 4px', display: 'flex', gap: 8, alignItems: 'center' }}>
        <input style={{ ...styles.input, width: 80, padding: '6px 10px' }} placeholder="Port" value={newPort}
          onChange={e => setNewPort(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()} />
        <select style={styles.select} value={newProto} onChange={e => setNewProto(e.target.value)}>
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
        </select>
        <select style={styles.select} value={newAction} onChange={e => setNewAction(e.target.value)}>
          <option value="allow">Allow</option>
          <option value="deny">Deny</option>
          <option value="reject">Reject</option>
        </select>
        <button style={{ ...styles.btnPrimary, ...(busy === 'add' ? styles.btnDisabled : {}) }}
          onClick={handleAdd} disabled={busy === 'add' || !newPort}>
          {busy === 'add' ? 'Adding…' : 'Add Rule'}
        </button>
      </div>
      {error && <div style={styles.errorRow}>{error}</div>}
      {rules !== null && rules.length === 0 && <div style={styles.item}><span style={styles.itemLabel}>No rules configured</span></div>}
      {rules !== null && rules.map(r => (
        <div key={r.number} style={styles.item}>
          <div>
            <div style={styles.itemLabel}>{r.to}</div>
            <div style={styles.itemSub}>{r.action} from {r.from}</div>
          </div>
          <button style={{ ...styles.btnDanger, ...(busy ? styles.btnDisabled : {}) }}
            onClick={() => handleDelete(r.number)} disabled={!!busy}>
            Delete
          </button>
        </div>
      ))}
    </SectionWrap>
  )
}

// ── Change Password ────────────────────────────────────────────────────────────
function ChangePasswordPanel() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [error, setError] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    if (next !== confirm) { setError('New passwords do not match'); return }
    setBusy(true); setError(null); setMsg(null)
    try {
      await changePassword(current, next)
      setCurrent(''); setNext(''); setConfirm('')
      setMsg('Password changed successfully.')
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  return (
    <SectionWrap icon="🔐" title="Change Password">
      <form onSubmit={handleSubmit} style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input type="password" placeholder="Current password" value={current}
          onChange={e => setCurrent(e.target.value)} style={styles.input} autoComplete="current-password" />
        <input type="password" placeholder="New password (min 8 chars)" value={next}
          onChange={e => setNext(e.target.value)} style={styles.input} autoComplete="new-password" />
        <input type="password" placeholder="Confirm new password" value={confirm}
          onChange={e => setConfirm(e.target.value)} style={styles.input} autoComplete="new-password" />
        {error && <div style={styles.errorRow}>{error}</div>}
        {msg && <div style={{ ...styles.errorRow, color: 'rgba(129,199,132,0.9)' }}>{msg}</div>}
        <button type="submit" style={{ ...styles.btnPrimary, alignSelf: 'flex-start', ...(busy ? styles.btnDisabled : {}) }}
          disabled={busy || !current || !next || !confirm}>
          {busy ? 'Changing…' : 'Change Password'}
        </button>
      </form>
    </SectionWrap>
  )
}

// ── Screen Lock PIN ──────────────────────────────────────────────────────────
const PIN_LENGTH = 4

function PinNumpad({ pin, onDigit, onBackspace, label, error }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '12px 16px 16px' }}>
      <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>{label}</div>
      {error && <div style={{ fontSize: 12, color: 'rgba(255,138,128,0.9)' }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, margin: '2px 0 6px' }}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <div key={i} style={{
            width: 12, height: 12, borderRadius: '50%',
            background: i < pin.length ? 'rgba(79,195,247,0.9)' : 'transparent',
            border: '2px solid ' + (i < pin.length ? 'rgba(79,195,247,0.9)' : 'rgba(255,255,255,0.3)'),
            transition: 'background 0.12s',
          }} />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {['1','2','3','4','5','6','7','8','9','','0','⌫'].map((d, i) => (
          <button key={i}
            style={{
              width: 54, height: 54, borderRadius: '50%',
              background: d === '' ? 'transparent' : 'rgba(255,255,255,0.08)',
              border: d === '' ? 'none' : '1px solid rgba(255,255,255,0.12)',
              color: 'rgba(255,255,255,0.85)', fontSize: 20, fontWeight: 400,
              cursor: d === '' ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onClick={() => d === '⌫' ? onBackspace() : d ? onDigit(d) : undefined}
            disabled={d === ''}
          >{d}</button>
        ))}
      </div>
    </div>
  )
}

function ScreenLockPanel() {
  const [hasPin, setHasPin] = useState(() => Boolean(localStorage.getItem('nimbus_lock_pin')))
  const [mode, setMode] = useState('idle') // idle | set | confirm
  const [pin, setPin] = useState('')
  const [firstPin, setFirstPin] = useState('')
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(null)

  function handleDigit(d) {
    if (pin.length >= PIN_LENGTH) return
    const next = pin + d
    setPin(next)
    if (next.length === PIN_LENGTH) setTimeout(() => advance(next), 80)
  }

  function advance(entered) {
    if (mode === 'set') {
      setFirstPin(entered); setPin(''); setMode('confirm'); setError(null)
    } else if (mode === 'confirm') {
      if (entered === firstPin) {
        localStorage.setItem('nimbus_lock_pin', entered)
        setHasPin(true); setMode('idle'); setPin(''); setFirstPin(''); setError(null)
        setSaved('PIN saved — screen lock is now active.'); setTimeout(() => setSaved(null), 3000)
      } else {
        setError('PINs did not match — try again'); setPin(''); setMode('set'); setFirstPin('')
      }
    }
  }

  function handleRemove() {
    localStorage.removeItem('nimbus_lock_pin')
    setHasPin(false); setMode('idle'); setPin(''); setFirstPin('')
    setSaved('PIN removed — screen lock disabled.'); setTimeout(() => setSaved(null), 3000)
  }

  function handleCancel() {
    setMode('idle'); setPin(''); setFirstPin(''); setError(null)
  }

  return (
    <SectionWrap icon="🔏" title="Screen Lock PIN">
      {mode === 'idle' ? (
        <>
          <div style={styles.item}>
            <div>
              <div style={styles.itemLabel}>Screen lock PIN</div>
              <div style={styles.itemSub}>
                {hasPin
                  ? 'A 4-digit PIN is required after idle timeout.'
                  : 'No PIN set — screen will not lock on idle.'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button style={styles.btnPrimary}
                onClick={() => { setMode('set'); setPin(''); setError(null) }}>
                {hasPin ? 'Change' : 'Set PIN'}
              </button>
              {hasPin && (
                <button style={styles.btnDanger} onClick={handleRemove}>Remove</button>
              )}
            </div>
          </div>
          {saved && (
            <div style={{ padding: '6px 16px 10px', fontSize: 12, color: 'rgba(129,199,132,0.9)' }}>
              ✓ {saved}
            </div>
          )}
        </>
      ) : (
        <>
          <PinNumpad
            pin={pin}
            onDigit={handleDigit}
            onBackspace={() => setPin(p => p.slice(0, -1))}
            label={mode === 'set' ? 'Enter a new 4-digit PIN' : 'Confirm your PIN'}
            error={error}
          />
          <div style={{ padding: '0 16px 14px', display: 'flex', justifyContent: 'center' }}>
            <button style={styles.btnCancel} onClick={handleCancel}>Cancel</button>
          </div>
        </>
      )}
    </SectionWrap>
  )
}

// ── Resource Limits ─────────────────────────────────────────────────────────
function ResourceLimitsPanel({ stats }) {
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
      setMsg('Resource limits updated.')
      await load()
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }

  if (!isLxd) return null

  return (
    <SectionWrap icon="⚙️" title="Container Resource Limits">
      {!containerReady ? (
        <div style={styles.item}><span style={styles.itemLabel}>Container must be ready to configure resource limits.</span></div>
      ) : (
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <label style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, width: 90 }}>CPU cores</label>
            <input style={{ ...styles.input, width: 80, padding: '6px 10px' }} placeholder="auto"
              value={cpu} onChange={e => setCpu(e.target.value.replace(/\D/g, ''))} />
            <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 11 }}>leave blank to use all</span>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <label style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, width: 90 }}>Memory (MB)</label>
            <input style={{ ...styles.input, width: 100, padding: '6px 10px' }} placeholder="auto"
              value={mem} onChange={e => setMem(e.target.value.replace(/\D/g, ''))} />
            <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 11 }}>e.g. 4096 for 4 GB</span>
          </div>
          {limits && (
            <div style={{ color: 'rgba(255,255,255,0.25)', fontSize: 11 }}>
              Current: {limits.cpu_cores != null ? `${limits.cpu_cores} vCPU` : 'unlimited CPU'},{' '}
              {limits.memory_mb != null ? `${limits.memory_mb} MB RAM` : 'unlimited RAM'}
            </div>
          )}
          {error && <div style={styles.errorRow}>{error}</div>}
          {msg && <div style={{ ...styles.errorRow, color: 'rgba(129,199,132,0.9)' }}>{msg}</div>}
          <button style={{ ...styles.btnPrimary, alignSelf: 'flex-start', ...(busy ? styles.btnDisabled : {}) }}
            onClick={handleSave} disabled={busy}>
            {busy ? 'Saving…' : 'Apply Limits'}
          </button>
        </div>
      )}
    </SectionWrap>
  )
}

// ── API Keys ───────────────────────────────────────────────────────────────────
function ApiKeysPanel() {
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
    if (!name.trim() || !value.trim()) { setError('Name and value are required'); return }
    setBusy('save'); setError(null); setMsg(null)
    try { await setApiKey(name.trim(), value.trim()); setName(''); setValue(''); setMsg('Key saved.'); await load() }
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
    <SectionWrap icon="🗝️" title="API Keys">
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...styles.input, width: 120 }} placeholder="Key name" value={name}
            onChange={e => setName(e.target.value)} />
          <input style={{ ...styles.input, flex: 1 }} placeholder="Value (e.g. sk-…)" value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()} />
          <button style={{ ...styles.btnPrimary, ...(busy === 'save' ? styles.btnDisabled : {}) }}
            onClick={handleSave} disabled={busy === 'save' || !name.trim() || !value.trim()}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
        </div>
        {error && <div style={styles.errorRow}>{error}</div>}
        {msg && <div style={{ ...styles.errorRow, color: 'rgba(129,199,132,0.9)' }}>{msg}</div>}
      </div>
      {keys !== null && keys.length === 0 && (
        <div style={styles.item}><span style={styles.itemLabel}>No API keys stored</span></div>
      )}
      {keys !== null && keys.map(k => (
        <div key={k.name} style={styles.item}>
          <div>
            <div style={{ ...styles.itemLabel, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>{k.name}</div>
            <div style={styles.itemSub}>{k.hint}</div>
          </div>
          <button style={{ ...styles.btnDanger, ...(busy === k.name ? styles.btnDisabled : {}) }}
            onClick={() => handleDelete(k.name)} disabled={!!busy}>
            {busy === k.name ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      ))}
    </SectionWrap>
  )
}

// ── Tailscale ─────────────────────────────────────────────────────────────────
function TailscalePanel() {
  const [status, setStatus] = useState(null)
  const [polling, setPolling] = useState(false)

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
    <SectionWrap icon="🔗" title="Tailscale">
      {/* Status row */}
      <div style={styles.item}>
        <div>
          <div style={styles.itemLabel}>
            {status === null ? 'Loading…' : connected ? 'Connected to tailnet' : 'Not connected'}
          </div>
          <div style={styles.itemSub}>
            {connected && ip
              ? `Tailscale IP: ${ip}`
              : 'Join your tailnet to access this device remotely'}
          </div>
        </div>
        <span style={{
          ...styles.statusPill,
          ...(connected ? styles.statusPillSuccess : styles.statusPillError),
        }}>
          {connected ? 'Connected' : 'Offline'}
        </span>
      </div>

      {/* How to connect — shown when not on tailnet */}
      {!connected && (
        <div style={{ padding: '10px 16px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ ...styles.itemSub, marginBottom: 6 }}>
            To connect this device to your tailnet, open a terminal and run:
          </div>
          <div style={{
            fontFamily: 'ui-monospace, monospace', fontSize: 12,
            background: 'rgba(0,0,0,0.3)', borderRadius: 6, padding: '6px 10px',
            color: 'rgba(129,212,250,0.9)', letterSpacing: '0.03em',
          }}>
            tailscale up
          </div>
          <div style={{ ...styles.itemSub, marginTop: 6 }}>
            An auth URL will appear — visit it on any device to authenticate.
          </div>
        </div>
      )}

      {/* Tailscale web client — accessible via reverse proxy; works even before connecting */}
      <div style={styles.item}>
        <div>
          <div style={styles.itemLabel}>Tailscale Web Client</div>
          <div style={styles.itemSub}>
            Manage tailscale settings, routes, and exit nodes
          </div>
        </div>
        <div style={styles.itemActions}>
          <button style={styles.btnPrimary} onClick={openWebClient}>
            Open
          </button>
        </div>
      </div>

      {/* Direct port-5252 link — only useful once on the tailnet */}
      {connected && ip && (
        <div style={styles.item}>
          <div>
            <div style={styles.itemLabel}>Remote Web Client</div>
            <div style={styles.itemSub}>
              Access from any tailnet device at {ip}:5252
            </div>
          </div>
          <button style={styles.btnSecondary} onClick={openDirectWebClient}>
            Open (port 5252)
          </button>
        </div>
      )}
    </SectionWrap>
  )
}

// ── Main Settings Component ────────────────────────────────────────────────────
export default function Settings({ stats, onRefresh }) {
  const [busyAction, setBusyAction] = useState(null)
  const [localMessage, setLocalMessage] = useState(null)

  const powerSupported = Boolean(stats?.device_management_available)
  const isLxd = stats?.control_mode === 'lxd'

  async function handleRestart() {
    setBusyAction('restart'); setLocalMessage(null)
    try { await restartSystem(); setLocalMessage('Restart requested.') }
    catch (e) { setLocalMessage(e.message) }
    finally { setBusyAction(null) }
  }

  return (
    <div style={styles.container}>
      {/* HTTPS Certificate */}
      <SectionWrap icon="🔒" title="HTTPS Certificate">
        <div style={styles.item}>
          <div>
            <div style={styles.itemLabel}>Trust Nimbus CA</div>
            <div style={styles.itemSub}>Install on each device to remove the HTTPS warning</div>
          </div>
          <a href="/api/system/ca-cert" download="nimbus-ca.crt" style={styles.btnDownload}>Download</a>
        </div>
        {stats?.tls_fingerprint && (
          <div style={styles.item}>
            <div style={styles.itemLabel}>Fingerprint</div>
            <span style={{ ...styles.addressPill, fontSize: 10, maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {stats.tls_fingerprint}
            </span>
          </div>
        )}
        <div style={styles.item}><div style={styles.itemLabel}>iOS / macOS</div><span style={styles.pillInfo}>Download → open → Settings → trust</span></div>
        <div style={styles.item}><div style={styles.itemLabel}>Android</div><span style={styles.pillInfo}>Settings → Security → Install cert</span></div>
        <div style={styles.item}><div style={styles.itemLabel}>Linux</div><span style={styles.pillInfo}>cp nimbus-ca.crt /usr/local/share/ca-certificates/ && update-ca-certificates</span></div>
      </SectionWrap>

      {/* System Updates */}
      <SectionWrap icon="⬆️" title="System">
        <div style={styles.item}>
          <div>
            <div style={styles.itemLabel}>Snap auto-refresh</div>
            <div style={styles.itemSub}>Nimbus and its dependencies update automatically on snapd's schedule. No manual trigger needed.</div>
          </div>
          <span style={{ ...styles.statusPill, ...styles.statusPillSuccess }}>Auto</span>
        </div>
        {stats?.version && (
          <div style={styles.item}>
            <div style={styles.itemLabel}>Version</div>
            <span style={styles.addressPill}>v{stats.version}</span>
          </div>
        )}
        <div style={styles.item}>
          <div>
            <div style={styles.itemLabel}>Restart system</div>
            <div style={styles.itemSub}>Reboot the device</div>
          </div>
          <button style={{ ...styles.btnPrimary, ...(!powerSupported || busyAction === 'restart' ? styles.btnDisabled : {}) }}
            onClick={handleRestart} disabled={!powerSupported || busyAction === 'restart'}>
            {busyAction === 'restart' ? 'Restarting…' : 'Restart'}
          </button>
        </div>
        {localMessage && (
          <div style={{ padding: '8px 16px', color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>{localMessage}</div>
        )}
      </SectionWrap>

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
  container: { display: 'flex', flexDirection: 'column', gap: '20px' },
  section: { background: 'rgba(255,255,255,0.04)', borderRadius: '12px', overflow: 'hidden' },
  sectionHeader: {
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)',
    background: 'rgba(255,255,255,0.03)',
  },
  sectionIcon: { fontSize: '16px' },
  sectionTitle: { color: 'rgba(255,255,255,0.7)', fontWeight: 600, fontSize: '13px' },
  itemList: {},
  item: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
    padding: '11px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  itemActions: { display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 },
  itemLabel: { color: 'rgba(255,255,255,0.65)', fontSize: '13px' },
  itemSub: { color: 'rgba(255,255,255,0.3)', fontSize: '11px', marginTop: '2px' },
  errorRow: { color: '#ff8a80', fontSize: '12px', padding: '0 2px' },
  btnDownload: {
    background: 'rgba(79,195,247,0.15)', color: 'rgba(79,195,247,0.9)',
    border: '1px solid rgba(79,195,247,0.3)', borderRadius: '8px',
    padding: '6px 14px', fontSize: '12px', fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap',
  },
  btnPrimary: {
    background: 'rgba(79,195,247,0.18)', color: 'rgba(79,195,247,0.98)',
    border: '1px solid rgba(79,195,247,0.3)', borderRadius: '8px',
    padding: '7px 14px', fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap', cursor: 'pointer',
  },
  btnSecondary: {
    background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.6)',
    border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px',
    padding: '6px 12px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  btnDanger: {
    background: 'rgba(255,138,128,0.12)', color: 'rgba(255,138,128,0.9)',
    border: '1px solid rgba(255,138,128,0.25)', borderRadius: '8px',
    padding: '7px 14px', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer',
  },
  btnCancel: {
    background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.45)',
    border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px',
    padding: '7px 14px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed' },
  statusPill: {
    fontSize: '10px', fontWeight: 700, padding: '4px 8px', borderRadius: '999px',
    textTransform: 'uppercase', letterSpacing: '0.06em',
  },
  statusPillInfo: { background: 'rgba(79,195,247,0.15)', color: 'rgba(129,212,250,0.95)' },
  statusPillSuccess: { background: 'rgba(129,199,132,0.16)', color: 'rgba(185,246,202,0.95)' },
  statusPillError: { background: 'rgba(255,138,128,0.16)', color: 'rgba(255,204,188,0.95)' },
  pillInfo: {
    background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)',
    fontSize: '10px', fontWeight: 500, padding: '3px 8px', borderRadius: '6px',
    fontFamily: 'monospace', maxWidth: '55%', textAlign: 'right',
  },
  addressPill: {
    background: 'rgba(79,195,247,0.12)', color: 'rgba(129,212,250,0.9)',
    fontSize: '12px', fontWeight: 500, padding: '3px 10px', borderRadius: '8px',
    fontFamily: 'ui-monospace, "SF Mono", "Fira Mono", monospace', whiteSpace: 'nowrap',
  },
  passwordRow: {
    display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '8px',
    padding: '8px 16px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)',
    background: 'rgba(255,255,255,0.02)',
  },
  input: {
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px', padding: '7px 12px', color: 'rgba(255,255,255,0.85)',
    fontSize: '13px', outline: 'none', boxSizing: 'border-box', width: '100%',
  },
  select: {
    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: '8px', padding: '7px 10px', color: 'rgba(255,255,255,0.75)',
    fontSize: '12px', outline: 'none', cursor: 'pointer',
  },
  showPwBtn: {
    position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
    background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', lineHeight: 1, padding: '2px',
  },
}
