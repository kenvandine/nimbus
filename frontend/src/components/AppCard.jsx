import { useState } from 'react'
import { installApp, uninstallApp, updateApp } from '../api.js'

const STATUS_COLORS = {
  running: '#4caf50',
  installed: '#ff9800',
  installing: '#2196f3',
  uninstalling: '#ff5722',
  available: 'rgba(255,255,255,0.25)',
}

export default function AppCard({ app, onRefresh, onOpenDetail, isInstalling = false }) {
  const [action, setAction] = useState(null) // null | 'installing' | 'uninstalling'
  const [error, setError] = useState(null)

  const status = isInstalling ? 'installing' : app.running ? 'running' : app.installed ? 'installed' : 'available'
  const busy = action !== null || isInstalling

  const statusLabel = action === 'installing' ? 'Installing…'
    : action === 'uninstalling' ? 'Uninstalling…'
    : action === 'updating' ? 'Updating…'
    : { running: 'Running', installed: 'Installed', installing: 'Installing…', available: 'Available' }[status]

  const dotColor = action ? STATUS_COLORS[action] : STATUS_COLORS[status]

  async function handleInstall(e) {
    e.stopPropagation()
    setAction('installing')
    setError(null)
    try {
      await installApp(app.id)
      onRefresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setAction(null)
    }
  }

  async function handleUninstall(e) {
    e.stopPropagation()
    setAction('uninstalling')
    setError(null)
    try {
      await uninstallApp(app.id)
      onRefresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setAction(null)
    }
  }

  async function handleUpdate(e) {
    e.stopPropagation()
    setAction('updating')
    setError(null)
    try {
      await updateApp(app.id)
      onRefresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setAction(null)
    }
  }

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
            <span style={{ ...styles.dot, background: dotColor }} />
            <span style={styles.statusText}>{statusLabel}</span>
          </div>
        </div>
      </div>

      {app.update_available && (
        <span style={styles.updateBadge}>⬆ Update available</span>
      )}
      <p style={styles.tagline}>{app.tagline || ''}</p>

      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.actions}>
        {status === 'available' && !busy && (
          <button style={styles.btnPrimary} onClick={handleInstall}>Install</button>
        )}
        {(action === 'installing' || isInstalling) && (
          <button style={styles.btnDisabled} disabled>
            <span style={styles.spinner} /> Installing…
          </button>
        )}
        {action === 'uninstalling' && (
          <button style={styles.btnDisabled} disabled>
            <span style={styles.spinner} /> Uninstalling…
          </button>
        )}
        {action === 'updating' && (
          <button style={styles.btnDisabled} disabled>
            <span style={styles.spinner} /> Updating…
          </button>
        )}
        {app.update_available && !busy && (
          <button style={styles.btnUpdate} onClick={handleUpdate}>⬆ Update</button>
        )}
        {status === 'running' && !busy && (
          <>
            {app.open_url && (
              <a href={app.open_url} target="_blank" rel="noreferrer" style={styles.btnOpen}
                onClick={e => e.stopPropagation()}>Open ↗</a>
            )}
            <button style={styles.btnDanger} onClick={handleUninstall}>Uninstall</button>
          </>
        )}
        {status === 'installed' && !busy && (
          <button style={styles.btnDanger} onClick={handleUninstall}>Uninstall</button>
        )}
      </div>
    </div>
  )
}

const styles = {
  card: {
    background: 'rgba(255,255,255,0.07)',
    backdropFilter: 'blur(12px)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '16px',
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    cursor: 'pointer',
    transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
  },
  icon: {
    width: '48px',
    height: '48px',
    borderRadius: '12px',
    objectFit: 'cover',
    flexShrink: 0,
  },
  iconPlaceholder: {
    width: '48px',
    height: '48px',
    borderRadius: '12px',
    background: 'rgba(255,255,255,0.15)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '22px',
    fontWeight: 700,
    color: 'white',
    flexShrink: 0,
  },
  titleBlock: { flex: 1, minWidth: 0 },
  name: {
    color: 'white',
    fontWeight: 600,
    fontSize: '15px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  statusRow: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' },
  dot: { width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0 },
  statusText: { color: 'rgba(255,255,255,0.55)', fontSize: '12px' },
  tagline: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: '13px',
    margin: 0,
    lineHeight: '1.5',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  error: { color: '#ff6b6b', fontSize: '12px', margin: 0 },
  updateBadge: {
    display: 'inline-block',
    background: 'rgba(255,152,0,0.18)',
    color: '#ffb74d',
    border: '1px solid rgba(255,152,0,0.35)',
    borderRadius: '6px',
    padding: '2px 8px',
    fontSize: '11px',
    fontWeight: 600,
  },
  btnUpdate: {
    background: 'rgba(255,152,0,0.75)', color: '#0a1628', border: 'none',
    borderRadius: '8px', padding: '7px 18px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
  },
  actions: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: 'auto' },
  btnPrimary: {
    background: 'rgba(79,195,247,0.8)', color: '#0a1628', border: 'none',
    borderRadius: '8px', padding: '7px 18px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
  },
  btnOpen: {
    background: 'rgba(76,175,80,0.8)', color: 'white', border: 'none',
    borderRadius: '8px', padding: '7px 18px', fontSize: '13px', fontWeight: 600,
    cursor: 'pointer', textDecoration: 'none', display: 'inline-block',
  },
  btnDanger: {
    background: 'rgba(255,255,255,0.1)', color: 'rgba(255,100,100,0.9)',
    border: '1px solid rgba(255,100,100,0.3)', borderRadius: '8px',
    padding: '7px 18px', fontSize: '13px', fontWeight: 600, cursor: 'pointer',
  },
  btnDisabled: {
    background: 'rgba(33,150,243,0.4)', color: 'rgba(255,255,255,0.6)', border: 'none',
    borderRadius: '8px', padding: '7px 18px', fontSize: '13px', fontWeight: 600,
    cursor: 'not-allowed', display: 'flex', alignItems: 'center', gap: '6px',
  },
  spinner: {
    display: 'inline-block', width: '10px', height: '10px',
    border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white',
    borderRadius: '50%', animation: 'spin 0.7s linear infinite',
  },
}
