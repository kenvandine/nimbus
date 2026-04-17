import { useState } from 'react'
import { installApp, uninstallApp, updateApp } from '../api.js'

export default function AppModal({ app, onClose, onRefresh }) {
  const [action, setAction] = useState(null)
  const [error, setError] = useState(null)
  const [activeImg, setActiveImg] = useState(0)

  if (!app) return null

  const status = app.running ? 'running' : app.installed ? 'installed' : 'available'
  const busy = action !== null

  async function handleInstall() {
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

  async function handleUninstall() {
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

  async function handleUpdate() {
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

  const statusColor = { running: '#4caf50', installed: '#ff9800', available: 'rgba(255,255,255,0.3)' }[status]
  const statusLabel = action === 'installing' ? 'Installing…'
    : action === 'uninstalling' ? 'Uninstalling…'
    : action === 'updating' ? 'Updating…'
    : { running: 'Running', installed: 'Installed', available: 'Available' }[status]

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={e => e.stopPropagation()}>
        {/* Close */}
        <button style={styles.closeBtn} onClick={onClose}>✕</button>

        {/* Hero header */}
        <div style={styles.hero}>
          {app.icon
            ? <img src={app.icon} alt="" style={styles.heroIcon} onError={e => { e.target.src = `/api/apps/${app.id}/icon.svg` }} />
            : <div style={{ ...styles.heroIcon, ...styles.iconFallback }}>{app.name[0]}</div>
          }
          <div style={styles.heroText}>
            <h2 style={styles.heroName}>{app.name}</h2>
            <p style={styles.heroTagline}>{app.tagline}</p>
            <div style={styles.metaRow}>
              <span style={{ ...styles.statusBadge, background: statusColor + '33', color: statusColor, border: `1px solid ${statusColor}55` }}>
                <span style={{ ...styles.dot, background: statusColor }} />
                {statusLabel}
              </span>
              {app.developer && <span style={styles.metaChip}>by {app.developer}</span>}
              {app.categories.map(c => (
                <span key={c} style={styles.metaChip}>{c}</span>
              ))}
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div style={styles.actionRow}>
          {status === 'available' && !busy && (
            <button style={styles.btnPrimary} onClick={handleInstall}>Install</button>
          )}
          {busy && (
            <button style={styles.btnBusy} disabled>
              <span style={styles.spinner} />
              {action === 'installing' ? 'Installing…' : 'Uninstalling…'}
            </button>
          )}
          {app.update_available && !busy && (
            <button style={styles.btnUpdate} onClick={handleUpdate}>⬆ Update</button>
          )}
          {status === 'running' && !busy && app.open_url && (
            <a href={app.open_url} target="_blank" rel="noreferrer" style={styles.btnOpen}>Open ↗</a>
          )}
          {(status === 'running' || status === 'installed') && !busy && (
            <button style={styles.btnDanger} onClick={handleUninstall}>Uninstall</button>
          )}
          {app.website && (
            <a href={app.website} target="_blank" rel="noreferrer" style={styles.btnGhost}>Website ↗</a>
          )}
        </div>

        {error && <p style={styles.error}>{error}</p>}

        {/* Gallery */}
        {app.gallery.length > 0 && (
          <div style={styles.gallerySection}>
            <div style={styles.galleryMain}>
              <img
                key={activeImg}
                src={app.gallery[activeImg]}
                alt={`Screenshot ${activeImg + 1}`}
                style={styles.galleryMainImg}
                onError={e => { e.target.style.display = 'none' }}
              />
            </div>
            {app.gallery.length > 1 && (
              <div style={styles.galleryThumbs}>
                {app.gallery.map((url, i) => (
                  <img
                    key={i}
                    src={url}
                    alt=""
                    style={{ ...styles.thumb, ...(i === activeImg ? styles.thumbActive : {}) }}
                    onClick={() => setActiveImg(i)}
                    onError={e => { e.target.style.display = 'none' }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Description */}
        {app.description && (
          <div style={styles.descSection}>
            <h3 style={styles.sectionTitle}>About</h3>
            <p style={styles.description}>{app.description}</p>
          </div>
        )}
      </div>
    </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.7)',
    backdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000, padding: '20px',
  },
  panel: {
    background: 'linear-gradient(160deg, #0f2035 0%, #0d1b2e 100%)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '20px',
    width: '100%', maxWidth: '720px',
    maxHeight: '90vh', overflowY: 'auto',
    padding: '32px',
    position: 'relative',
    display: 'flex', flexDirection: 'column', gap: '24px',
  },
  closeBtn: {
    position: 'absolute', top: '16px', right: '16px',
    background: 'rgba(255,255,255,0.08)', border: 'none', color: 'rgba(255,255,255,0.6)',
    width: '32px', height: '32px', borderRadius: '8px', cursor: 'pointer',
    fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  hero: { display: 'flex', gap: '20px', alignItems: 'flex-start' },
  heroIcon: { width: '72px', height: '72px', borderRadius: '16px', objectFit: 'cover', flexShrink: 0 },
  iconFallback: {
    background: 'rgba(255,255,255,0.15)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', fontSize: '32px', fontWeight: 700, color: 'white',
  },
  heroText: { flex: 1 },
  heroName: { color: 'white', margin: '0 0 6px', fontSize: '22px', fontWeight: 700 },
  heroTagline: { color: 'rgba(255,255,255,0.6)', margin: '0 0 12px', fontSize: '14px' },
  metaRow: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
  statusBadge: {
    display: 'inline-flex', alignItems: 'center', gap: '5px',
    padding: '3px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 600,
  },
  dot: { width: '6px', height: '6px', borderRadius: '50%' },
  metaChip: {
    background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)',
    padding: '3px 10px', borderRadius: '20px', fontSize: '12px',
  },
  actionRow: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
  btnPrimary: {
    background: 'rgba(79,195,247,0.85)', color: '#0a1628', border: 'none',
    borderRadius: '10px', padding: '10px 24px', fontSize: '14px', fontWeight: 700, cursor: 'pointer',
  },
  btnOpen: {
    background: 'rgba(76,175,80,0.85)', color: 'white', border: 'none',
    borderRadius: '10px', padding: '10px 24px', fontSize: '14px', fontWeight: 700,
    cursor: 'pointer', textDecoration: 'none', display: 'inline-block',
  },
  btnDanger: {
    background: 'transparent', color: 'rgba(255,100,100,0.9)',
    border: '1px solid rgba(255,100,100,0.35)', borderRadius: '10px',
    padding: '10px 24px', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
  },
  btnUpdate: {
    background: 'rgba(255,152,0,0.8)', color: '#0a1628', border: 'none',
    borderRadius: '10px', padding: '10px 24px', fontSize: '14px', fontWeight: 700, cursor: 'pointer',
  },
  btnGhost: {
    background: 'transparent', color: 'rgba(255,255,255,0.45)',
    border: '1px solid rgba(255,255,255,0.15)', borderRadius: '10px',
    padding: '10px 24px', fontSize: '14px', cursor: 'pointer', textDecoration: 'none',
    display: 'inline-block',
  },
  btnBusy: {
    background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)', border: 'none',
    borderRadius: '10px', padding: '10px 24px', fontSize: '14px', cursor: 'not-allowed',
    display: 'flex', alignItems: 'center', gap: '8px',
  },
  spinner: {
    display: 'inline-block', width: '12px', height: '12px',
    border: '2px solid rgba(255,255,255,0.2)', borderTopColor: 'white',
    borderRadius: '50%', animation: 'spin 0.7s linear infinite',
  },
  error: { color: '#ff6b6b', fontSize: '13px', margin: 0 },
  gallerySection: { display: 'flex', flexDirection: 'column', gap: '10px' },
  galleryMain: {
    borderRadius: '12px', overflow: 'hidden',
    background: 'rgba(0,0,0,0.3)', aspectRatio: '16/9',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  galleryMainImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  galleryThumbs: { display: 'flex', gap: '8px', overflowX: 'auto' },
  thumb: {
    width: '80px', height: '52px', objectFit: 'cover',
    borderRadius: '8px', cursor: 'pointer', opacity: 0.55,
    border: '2px solid transparent', flexShrink: 0, transition: 'opacity 0.15s',
  },
  thumbActive: { opacity: 1, border: '2px solid rgba(79,195,247,0.8)' },
  descSection: {},
  sectionTitle: { color: 'rgba(255,255,255,0.4)', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px' },
  description: { color: 'rgba(255,255,255,0.65)', fontSize: '14px', lineHeight: '1.7', margin: 0, whiteSpace: 'pre-wrap' },
}
