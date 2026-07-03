import { useState } from 'react'
import { ArrowUp } from 'lucide-react'
import { installApp, uninstallApp, updateApp, startApp, stopApp, restartApp } from '../api.js'
import { openApp } from '../utils.js'
import Button from './ui/Button.jsx'
import Badge from './ui/Badge.jsx'
import StatusDot from './ui/StatusDot.jsx'

const STATUS_TONE = {
  running: 'success',
  installed: 'warning',
  installing: 'info',
  uninstalling: 'danger',
  stopping: 'danger',
  starting: 'info',
  restarting: 'warning',
  available: 'neutral',
}

export default function AppCard({ app, onRefresh, onOpenDetail, isInstalling = false }) {
  const [action, setAction] = useState(null) // null | 'installing' | 'uninstalling'
  const [error, setError] = useState(null)

  const status = isInstalling ? 'installing' : app.running ? 'running' : app.installed ? 'installed' : 'available'
  const busy = action !== null || isInstalling

  const statusLabel = action === 'installing' ? 'Installing…'
    : action === 'uninstalling' ? 'Uninstalling…'
    : action === 'updating' ? 'Updating…'
    : action === 'starting' ? 'Starting…'
    : action === 'stopping' ? 'Stopping…'
    : action === 'restarting' ? 'Restarting…'
    : { running: 'Running', installed: 'Installed', installing: 'Installing…', available: 'Available' }[status]

  const tone = action ? (STATUS_TONE[action] || 'neutral') : STATUS_TONE[status]

  async function withAction(name, fn, e) {
    e.stopPropagation()
    setAction(name)
    setError(null)
    try {
      await fn()
      onRefresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setAction(null)
    }
  }

  const handleInstall = e => withAction('installing', () => installApp(app.id), e)
  const handleUninstall = e => withAction('uninstalling', () => uninstallApp(app.id), e)
  const handleUpdate = e => withAction('updating', () => updateApp(app.id), e)
  const handleStart = e => withAction('starting', () => startApp(app.id), e)
  const handleStop = e => withAction('stopping', () => stopApp(app.id), e)
  const handleRestart = e => withAction('restarting', () => restartApp(app.id), e)

  return (
    <div style={styles.card} onClick={() => onOpenDetail(app)}>
      <div style={styles.header}>
        {app.icon
          ? <img src={app.icon} alt="" style={styles.icon} onError={e => { e.target.src = `/api/apps/${app.id}/icon.svg` }} />
          : <div style={styles.iconPlaceholder}>{app.name[0]}</div>
        }
        <div style={styles.titleBlock}>
          <div style={styles.name}>{app.name}</div>
          <div style={styles.statusRow}>
            <StatusDot tone={tone} label={statusLabel} />
          </div>
        </div>
      </div>

      {app.update_available && (
        <Badge tone="warning" style={{ alignSelf: 'flex-start' }}><ArrowUp size={11} /> Update available</Badge>
      )}
      <p style={styles.tagline}>{app.tagline || ''}</p>
      {app.confinement && (
        <Badge tone={app.confinement === 'classic' ? 'warning' : 'success'} style={{ alignSelf: 'flex-start' }}>
          {app.confinement}
        </Badge>
      )}

      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.actions}>
        {status === 'available' && !busy && (
          <Button variant="primary" size="sm" onClick={handleInstall}>Install</Button>
        )}
        {(action === 'installing' || isInstalling) && <Button variant="secondary" size="sm" loading disabled>Installing…</Button>}
        {action === 'uninstalling' && <Button variant="secondary" size="sm" loading disabled>Uninstalling…</Button>}
        {action === 'updating' && <Button variant="secondary" size="sm" loading disabled>Updating…</Button>}
        {action === 'starting' && <Button variant="secondary" size="sm" loading disabled>Starting…</Button>}
        {action === 'stopping' && <Button variant="secondary" size="sm" loading disabled>Stopping…</Button>}
        {action === 'restarting' && <Button variant="secondary" size="sm" loading disabled>Restarting…</Button>}
        {app.update_available && !busy && (
          <Button variant="soft" size="sm" onClick={handleUpdate}><ArrowUp size={13} /> Update</Button>
        )}
        {status === 'running' && !busy && (
          <>
            {app.open_url && (
              <Button variant="primary" size="sm" onClick={e => { e.stopPropagation(); openApp(app.open_url, { name: app.name, id: app.id }) }}>Open ↗</Button>
            )}
            {app.has_service && (
              <>
                <Button variant="secondary" size="sm" onClick={handleRestart}>Restart</Button>
                <Button variant="secondary" size="sm" onClick={handleStop}>Stop</Button>
              </>
            )}
            <Button variant="danger" size="sm" onClick={handleUninstall}>Uninstall</Button>
          </>
        )}
        {status === 'installed' && !busy && (
          <>
            {app.has_service && <Button variant="primary" size="sm" onClick={handleStart}>Start</Button>}
            <Button variant="danger" size="sm" onClick={handleUninstall}>Uninstall</Button>
          </>
        )}
      </div>
    </div>
  )
}

const styles = {
  card: {
    background: 'var(--color-surface-1)',
    backdropFilter: 'blur(var(--blur-md))',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-lg)',
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    cursor: 'pointer',
    transition: 'transform var(--duration-fast), box-shadow var(--duration-fast), border-color var(--duration-fast)',
    fontFamily: 'var(--font-sans)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
  },
  icon: {
    width: '48px',
    height: '48px',
    borderRadius: 'var(--radius-md)',
    objectFit: 'cover',
    flexShrink: 0,
  },
  iconPlaceholder: {
    width: '48px',
    height: '48px',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-surface-3)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '22px',
    fontWeight: 700,
    color: 'var(--text-primary)',
    flexShrink: 0,
  },
  titleBlock: { flex: 1, minWidth: 0 },
  name: {
    color: 'var(--text-primary)',
    fontWeight: 600,
    fontSize: '15px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  statusRow: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' },
  tagline: {
    color: 'var(--text-secondary)',
    fontSize: '13px',
    margin: 0,
    lineHeight: '1.5',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  error: { color: 'var(--color-danger)', fontSize: '12px', margin: 0 },
  actions: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: 'auto' },
}
