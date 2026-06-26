import { useState } from 'react'

function buildApps(appstoreVisible, terminalAvailable) {
  const apps = []
  if (appstoreVisible !== false) {
    apps.push({
      id: 'appstore',
      label: 'App Store',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 28, height: 28 }}>
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
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 28, height: 28 }}>
          <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z" />
          <path d="M8 13h8M8 16h5" />
        </svg>
      ),
    },
    {
      id: 'deviceinfo',
      label: 'Device Info',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 28, height: 28 }}>
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="M9 9h1m5 0h-2M9 12h6M9 15h4" />
        </svg>
      ),
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 28, height: 28 }}>
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
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 28, height: 28 }}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 9l4 3-4 3M13 15h4" />
        </svg>
      ),
    })
  }
  return apps
}

export default function Dock({ onOpen, updatableCount, appUpdateCount = 0, appstoreVisible = true, terminalAvailable = false }) {
  const [hovered, setHovered] = useState(null)
  const APPS = buildApps(appstoreVisible, terminalAvailable)

  const totalUpdates = Math.max(updatableCount || 0, appUpdateCount || 0)

  return (
    <div className="dock-bar" style={styles.bar}>
      <div style={styles.dock}>
        {APPS.map(app => (
          <DockIcon
            key={app.id}
            app={app}
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

function DockIcon({ app, badge, hovered, onMouseEnter, onMouseLeave, onClick }) {
  return (
    <div
      style={styles.iconWrap}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      <div style={{ ...styles.iconBtn, ...(hovered ? styles.iconBtnHover : {}) }}>
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
    paddingBottom: '16px',
    paddingTop: '8px',
    flexShrink: 0,
  },
  dock: {
    display: 'flex',
    gap: '8px',
    background: 'rgba(255,255,255,0.12)',
    backdropFilter: 'blur(24px)',
    WebkitBackdropFilter: 'blur(24px)',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: '22px',
    padding: '10px 16px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
  },
  iconWrap: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  iconBtn: {
    width: '52px',
    height: '52px',
    borderRadius: '14px',
    background: 'rgba(255,255,255,0.1)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    color: 'rgba(255,255,255,0.85)',
    transition: 'transform 0.15s, background 0.15s',
    position: 'relative',
  },
  iconBtnHover: {
    transform: 'translateY(-6px) scale(1.12)',
    background: 'rgba(255,255,255,0.2)',
  },
  badge: {
    position: 'absolute',
    top: '-5px',
    right: '-5px',
    background: '#ff3b30',
    color: 'white',
    fontSize: '10px',
    fontWeight: 700,
    minWidth: '17px',
    height: '17px',
    borderRadius: '9px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 4px',
    border: '1.5px solid rgba(0,0,0,0.3)',
  },
  tooltip: {
    position: 'absolute',
    bottom: '100%',
    marginBottom: '6px',
    background: 'rgba(0,0,0,0.75)',
    color: 'white',
    fontSize: '11px',
    fontWeight: 500,
    padding: '4px 8px',
    borderRadius: '6px',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  },
}
