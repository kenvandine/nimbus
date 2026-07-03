import { useState, useCallback, useEffect } from 'react'
import { X, ArrowUp, Check, Copy } from 'lucide-react'
import { installApp, uninstallApp, updateApp } from '../api.js'
import { openApp } from '../utils.js'
import Button from './ui/Button.jsx'
import StatusDot from './ui/StatusDot.jsx'

export default function AppModal({ app, onClose, onRefresh, isInstalling = false }) {
  const [action, setAction] = useState(null)
  const [error, setError] = useState(null)
  const [activeImg, setActiveImg] = useState(0)

  useEffect(() => {
    if (!app) return undefined

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [app, onClose])

  if (!app) return null

  const status = isInstalling ? 'installing' : app.running ? 'running' : app.installed ? 'installed' : 'available'
  const busy = action !== null || isInstalling

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

  const statusTone = { running: 'success', installed: 'warning', installing: 'info', available: 'neutral' }[status]
  const statusLabel = action === 'installing' ? 'Installing…'
    : action === 'uninstalling' ? 'Uninstalling…'
    : action === 'updating' ? 'Updating…'
    : { running: 'Running', installed: 'Installed', installing: 'Installing…', available: 'Available' }[status]

  return (
    <div className="modal-overlay" style={styles.overlay} onClick={onClose}>
      <div className="modal-panel" style={styles.panel} onClick={e => e.stopPropagation()}>
        <button style={styles.closeBtn} onClick={onClose} aria-label="Close"><X size={16} /></button>

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
              <span style={styles.statusBadge}><StatusDot tone={statusTone} label={statusLabel} /></span>
              {app.developer && <span style={styles.metaChip}>by {app.developer}</span>}
              {app.confinement && (
                <span style={{
                  ...styles.metaChip,
                  ...(app.confinement === 'classic'
                    ? { background: 'var(--color-warning-soft-bg)', color: 'var(--color-warning-soft-text)', border: '1px solid var(--color-warning-soft-border)' }
                    : { background: 'var(--color-success-soft-bg)', color: 'var(--color-success-soft-text)', border: '1px solid var(--color-success-soft-border)' }
                  ),
                }}>{app.confinement}</span>
              )}
              {app.categories.map(c => (
                <span key={c} style={styles.metaChip}>{c}</span>
              ))}
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div style={styles.actionRow}>
          {status === 'available' && !busy && <Button variant="primary" onClick={handleInstall}>Install</Button>}
          {busy && (
            <Button variant="secondary" loading disabled>
              {action === 'updating' ? 'Updating…' : action === 'uninstalling' ? 'Uninstalling…' : 'Installing…'}
            </Button>
          )}
          {app.update_available && !busy && <Button variant="soft" onClick={handleUpdate}><ArrowUp size={14} /> Update</Button>}
          {status === 'running' && !busy && app.open_url && (
            <Button variant="primary" onClick={() => openApp(app.open_url, { name: app.name, id: app.id })}>Open ↗</Button>
          )}
          {(status === 'running' || status === 'installed') && !busy && (
            <Button variant="danger" onClick={handleUninstall}>Uninstall</Button>
          )}
          {app.website && <Button variant="ghost" onClick={() => openApp(app.website)}>Website ↗</Button>}
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

        {/* Default credentials */}
        {(app.default_username || app.default_password) && (
          <div style={styles.descSection}>
            <h3 style={styles.sectionTitle}>Default Credentials</h3>
            <div style={styles.credTable}>
              {app.default_username && <CredRow label="Username" value={app.default_username} />}
              {app.default_password && <CredRow label="Password" value={app.default_password} />}
            </div>
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
      <style>{`
        @media (max-width: 640px) {
          .modal-overlay {
            padding: 8px !important;
            padding-top: calc(8px + env(safe-area-inset-top, 0px)) !important;
            padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px)) !important;
          }
          .modal-panel {
            max-height: 100% !important;
            padding: 20px !important;
            border-radius: 12px !important;
          }
        }
      `}</style>
    </div>
  )
}

function fallbackCopy(text, done) {
  const el = document.createElement('textarea')
  el.value = text
  el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0'
  document.body.appendChild(el)
  el.select()
  document.execCommand('copy')
  document.body.removeChild(el)
  done()
}

function CredRow({ label, value }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500) }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(value).then(done).catch(() => fallbackCopy(value, done))
    } else {
      fallbackCopy(value, done)
    }
  }, [value])
  return (
    <div style={styles.credRow}>
      <span style={styles.credLabel}>{label}</span>
      <div style={styles.credValueWrap}>
        <code style={styles.credValue}>{value}</code>
        <button style={styles.copyBtn} onClick={copy} title="Copy">
          {copied ? <Check size={13} color="var(--color-accent-soft-text)" /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'var(--color-overlay-scrim)',
    backdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000, padding: '20px',
  },
  panel: {
    background: 'var(--color-surface-2)',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-xl)',
    width: '100%', maxWidth: '720px',
    maxHeight: '90vh', overflowY: 'auto',
    padding: '32px',
    position: 'relative',
    display: 'flex', flexDirection: 'column', gap: '24px',
    fontFamily: 'var(--font-sans)',
    boxShadow: 'var(--shadow-xl)',
  },
  closeBtn: {
    position: 'absolute', top: '16px', right: '16px',
    background: 'var(--color-surface-3)', border: 'none', color: 'var(--text-secondary)',
    width: '32px', height: '32px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  hero: { display: 'flex', gap: '20px', alignItems: 'flex-start' },
  heroIcon: { width: '72px', height: '72px', borderRadius: 'var(--radius-lg)', objectFit: 'cover', flexShrink: 0 },
  iconFallback: {
    background: 'var(--color-surface-3)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', fontSize: '32px', fontWeight: 700, color: 'var(--text-primary)',
  },
  heroText: { flex: 1 },
  heroName: { color: 'var(--text-primary)', margin: '0 0 6px', fontSize: '22px', fontWeight: 700 },
  heroTagline: { color: 'var(--text-secondary)', margin: '0 0 12px', fontSize: '14px' },
  metaRow: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
  statusBadge: { display: 'inline-flex', alignItems: 'center' },
  metaChip: {
    background: 'var(--color-surface-3)', color: 'var(--text-secondary)',
    padding: '3px 10px', borderRadius: 'var(--radius-full)', fontSize: '12px',
  },
  actionRow: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
  error: { color: 'var(--color-danger)', fontSize: '13px', margin: 0 },
  gallerySection: { display: 'flex', flexDirection: 'column', gap: '10px' },
  galleryMain: {
    borderRadius: 'var(--radius-md)', overflow: 'hidden',
    background: 'rgba(0,0,0,0.3)', aspectRatio: '16/9',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  galleryMainImg: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
  galleryThumbs: { display: 'flex', gap: '8px', overflowX: 'auto' },
  thumb: {
    width: '80px', height: '52px', objectFit: 'cover',
    borderRadius: 'var(--radius-sm)', cursor: 'pointer', opacity: 0.55,
    border: '2px solid transparent', flexShrink: 0, transition: 'opacity var(--duration-fast)',
  },
  thumbActive: { opacity: 1, border: '2px solid var(--color-accent)' },
  descSection: {},
  credTable: {
    background: 'var(--color-surface-1)',
    borderRadius: 'var(--radius-sm)',
    overflow: 'hidden',
  },
  credRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    borderBottom: '1px solid var(--color-border-subtle)',
  },
  credLabel: {
    color: 'var(--text-tertiary)',
    fontSize: '13px',
  },
  credValueWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  credValue: {
    background: 'var(--color-accent-soft-bg)',
    color: 'var(--color-accent-soft-text)',
    border: '1px solid var(--color-accent-soft-border)',
    borderRadius: 'var(--radius-sm)',
    padding: '2px 8px',
    fontSize: '13px',
    fontFamily: 'var(--font-mono)',
  },
  copyBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    padding: '2px',
    display: 'flex',
    alignItems: 'center',
    borderRadius: 'var(--radius-sm)',
    transition: 'color var(--duration-fast)',
  },
  sectionTitle: { color: 'var(--text-tertiary)', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px' },
  description: { color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.7', margin: 0, whiteSpace: 'pre-wrap' },
}
