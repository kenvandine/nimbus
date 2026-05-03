import { useEffect } from 'react'

export default function Window({ title, onClose, children, noPad = false }) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.window} onClick={event => event.stopPropagation()}>
        <div style={styles.titleBar}>
          <span style={styles.titleText}>{title}</span>
          <button style={styles.closeBtn} onClick={onClose} title="Close">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div style={{ ...styles.content, ...(noPad ? styles.contentNoPad : {}) }}>{children}</div>
      </div>
    </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    backdropFilter: 'blur(6px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    padding: '20px',
  },
  window: {
    background: 'linear-gradient(160deg,#0f2035 0%,#0b1928 100%)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '8px',
    width: '100%',
    maxWidth: '960px',
    height: '80vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
  },
  titleBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px 0 16px',
    height: '38px',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    flexShrink: 0,
    background: 'rgba(255,255,255,0.04)',
  },
  titleText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: '13px',
    fontWeight: 600,
    letterSpacing: '0.01em',
  },
  closeBtn: {
    width: '26px',
    height: '26px',
    borderRadius: '6px',
    border: 'none',
    background: 'rgba(255,255,255,0.08)',
    color: 'rgba(255,255,255,0.55)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    transition: 'background 0.15s, color 0.15s',
  },
  content: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px 24px',
  },
  contentNoPad: {
    padding: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
}
