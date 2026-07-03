import { useState } from 'react'
import { useTranslation } from '../i18n.jsx'

function buildApps(appstoreVisible, terminalAvailable) {
  const apps = []
  if (appstoreVisible !== false) {
    apps.push({
      id: 'appstore',
      label: 'App Store',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 26, height: 26 }}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      ),
    })
  }
  apps.push(
    {
      id: 'files',
      label: 'Files',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 26, height: 26 }}>
          <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />
          <path d="M8 13h8M8 16h5" />
        </svg>
      ),
    },
    {
      id: 'deviceinfo',
      label: 'Device Info',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 26, height: 26 }}>
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="M9 9h1m5 0h-2M9 12h6M9 15h4" />
        </svg>
      ),
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 26, height: 26 }}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      ),
    },
  )
  if (terminalAvailable) {
    apps.push({
      id: 'terminal',
      label: 'Terminal',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 26, height: 26 }}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 9l4 3-4 3M13 15h4" />
        </svg>
      ),
    })
  }
  return apps
}

export default function Dock({ onOpen, activeId, updatableCount, appUpdateCount = 0, appstoreVisible = true, terminalAvailable = false }) {
  const { t } = useTranslation()
  const [hovered, setHovered] = useState(null)
  const APPS = buildApps(appstoreVisible, terminalAvailable).map(app => ({
    ...app,
    label: {
      appstore: t('dock_appstore', 'App Store'),
      files: t('dock_files', 'Files'),
      deviceinfo: t('dock_deviceinfo', 'Device Info'),
      settings: t('dock_settings', 'Settings'),
      terminal: t('dock_terminal', 'Terminal'),
    }[app.id] || app.label
  }))

  const totalUpdates = Math.max(updatableCount || 0, appUpdateCount || 0)

  return (
    <div className="dock-bar" style={styles.bar}>
      <div style={styles.dock}>
        {APPS.map(app => (
          <DockIcon
            key={app.id}
            app={app}
            active={activeId === app.id}
            badge={app.id === 'appstore' ? totalUpdates : 0}
            hovered={hovered === app.id}
            onMouseEnter={() => setHovered(app.id)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onOpen(app.id)}
          />
        ))}
      </div>
      <style>{`
        .dock-bar {
          padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px)) !important;
        }
      `}</style>
    </div>
  )
}

function DockIcon({ app, badge, active, hovered, onMouseEnter, onMouseLeave, onClick }) {
  return (
    <div
      style={styles.iconWrap}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      <div style={{ ...styles.iconBtn, ...(active ? styles.iconBtnActive : {}), ...(hovered ? styles.iconBtnHover : {}) }}>
        {app.icon}
        {badge > 0 && <span style={styles.badge}>{badge}</span>}
      </div>
      {hovered && <div style={styles.tooltip}>{app.label}</div>}
    </div>
  )
}

const styles = {
  bar: {
    display: 'flex',
    justifyContent: 'center',
    paddingBottom: 16,
    paddingTop: 8,
    flexShrink: 0,
  },
  dock: {
    display: 'flex',
    gap: 8,
    background: 'var(--color-surface-3)',
    backdropFilter: 'blur(var(--blur-lg))',
    WebkitBackdropFilter: 'blur(var(--blur-lg))',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-xl)',
    padding: '10px 16px',
    boxShadow: 'var(--shadow-md)',
  },
  iconWrap: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  iconBtn: {
    width: 52,
    height: 52,
    borderRadius: 'var(--radius-md)',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    color: 'var(--text-secondary)',
    transition: 'transform var(--duration-fast), background var(--duration-fast), color var(--duration-fast)',
    position: 'relative',
  },
  iconBtnActive: {
    background: 'var(--color-accent-soft-bg)',
    color: 'var(--color-accent-soft-text)',
  },
  iconBtnHover: {
    transform: 'translateY(-6px) scale(1.12)',
    background: 'var(--color-surface-3)',
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -5,
    background: 'var(--color-warning)',
    color: 'var(--color-text-on-accent)',
    fontSize: 10,
    fontWeight: 700,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 4px',
    border: '1.5px solid var(--color-bg-canvas)',
  },
  tooltip: {
    position: 'absolute',
    bottom: '100%',
    marginBottom: 6,
    background: 'var(--nimbus-charcoal-900)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
    fontSize: 11,
    fontWeight: 500,
    padding: '4px 8px',
    borderRadius: 'var(--radius-sm)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    border: '1px solid var(--color-border-subtle)',
  },
}
