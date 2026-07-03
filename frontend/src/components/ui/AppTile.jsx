import { useState, useRef, useEffect } from 'react'
import { MoreVertical } from 'lucide-react'

// Launcher grid tile. Replaces the old desktop-icon + right-click-only
// context menu: secondary actions (restart/stop/uninstall/logs/info) now
// live behind an explicit "..." button that works identically for mouse
// click and touch tap, instead of needing separate right-click vs.
// long-press handling.
export default function AppTile({ app, onOpen, onAction }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!menuOpen) return
    function dismiss(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setMenuOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('click', dismiss)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', dismiss)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const actions = []
  if (app.open_url) actions.push({ key: 'open', label: 'Open' })
  if (!app.is_system) actions.push({ key: 'info', label: 'View info' })
  if (!app.is_system) actions.push({ key: 'logs', label: 'View logs' })
  if (app.has_service) {
    if (app.running) {
      actions.push({ key: 'restart', label: 'Restart service' })
      actions.push({ key: 'stop', label: 'Stop service' })
    } else {
      actions.push({ key: 'start', label: 'Start service' })
    }
  }
  if (!app.is_system) actions.push({ key: 'uninstall', label: 'Uninstall', danger: true })

  return (
    <div ref={wrapRef} style={styles.tile}>
      <button type="button" style={styles.tap} onClick={() => onOpen?.(app)}>
        <div style={styles.iconWrap}>
          <img
            src={app.icon}
            alt=""
            style={styles.icon}
            onError={e => { e.target.src = `/api/apps/${app.id}/icon.svg` }}
          />
          {app.update_available && <span style={styles.updateDot} title="Update available" />}
        </div>
        <span style={styles.label}>{app.name}</span>
      </button>

      {actions.length > 0 && (
        <button
          style={styles.menuBtn}
          aria-label={`${app.name} actions`}
          onClick={e => { e.stopPropagation(); setMenuOpen(o => !o) }}
        >
          <MoreVertical size={15} />
        </button>
      )}

      {menuOpen && (
        <div style={styles.menu} onClick={e => e.stopPropagation()}>
          {actions.map(a => (
            <button
              key={a.key}
              style={{ ...styles.menuItem, ...(a.danger ? styles.menuItemDanger : {}) }}
              onClick={() => { setMenuOpen(false); onAction?.(a.key, app) }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const styles = {
  tile: {
    position: 'relative',
    width: 96,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  tap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    padding: '12px 6px 8px',
    background: 'none',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    transition: 'background var(--duration-fast)',
  },
  iconWrap: { position: 'relative' },
  icon: {
    width: 60,
    height: 60,
    borderRadius: 'var(--radius-lg)',
    objectFit: 'cover',
    boxShadow: 'var(--shadow-sm)',
  },
  updateDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 12,
    height: 12,
    borderRadius: '50%',
    background: 'var(--color-warning)',
    border: '2px solid var(--color-bg-canvas)',
  },
  label: {
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-primary)',
    textAlign: 'center',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '100%',
  },
  menuBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 26,
    height: 26,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--color-surface-2)',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-full)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
  },
  menu: {
    position: 'absolute',
    top: 34,
    right: 4,
    minWidth: 170,
    background: 'var(--color-surface-3)',
    backdropFilter: 'blur(var(--blur-lg))',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-md)',
    padding: 6,
    zIndex: 50,
    boxShadow: 'var(--shadow-lg)',
  },
  menuItem: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    background: 'none',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    padding: '9px 12px',
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  menuItemDanger: {
    color: 'var(--color-danger)',
  },
}
