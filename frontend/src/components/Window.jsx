import { useEffect } from 'react'
import { X } from 'lucide-react'

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
    <div className="window-overlay" style={styles.overlay} onClick={onClose}>
      <div className="window-container" style={styles.window} onClick={event => event.stopPropagation()}>
        <div style={styles.titleBar}>
          <span style={styles.titleText}>{title}</span>
          <button style={styles.closeBtn} onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>
        <div style={{ ...styles.content, ...(noPad ? styles.contentNoPad : {}) }}>{children}</div>
      </div>
      <style>{`
        @media (max-width: 640px) {
          .window-overlay {
            padding: 8px !important;
            padding-top: calc(8px + env(safe-area-inset-top, 0px)) !important;
            padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px)) !important;
          }
          .window-container {
            height: 100% !important;
            max-height: 100% !important;
            border-radius: 12px !important;
          }
        }
      `}</style>
    </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'var(--color-overlay-scrim)',
    backdropFilter: 'blur(6px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    padding: '20px',
  },
  window: {
    background: 'var(--color-surface-2)',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-lg)',
    width: '100%',
    maxWidth: '960px',
    height: '80vh',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    boxShadow: 'var(--shadow-xl)',
  },
  titleBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px 0 16px',
    height: '44px',
    borderBottom: '1px solid var(--color-border-subtle)',
    flexShrink: 0,
    background: 'var(--color-surface-1)',
  },
  titleText: {
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
    fontSize: '13px',
    fontWeight: 700,
    letterSpacing: '0.01em',
  },
  closeBtn: {
    width: '30px',
    height: '30px',
    borderRadius: 'var(--radius-sm)',
    border: 'none',
    background: 'var(--color-surface-3)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    transition: 'background var(--duration-fast), color var(--duration-fast)',
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
