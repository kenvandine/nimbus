import { useEffect } from 'react'
import { X } from 'lucide-react'

// A small, genuinely transient overlay — confirmations, install progress,
// popovers. Distinct from the primary-navigation "Window" chrome (which is
// being retired in favor of routed full-screen pages; see the frontend
// redesign plan). Use this for content that should interrupt briefly and
// then go away, not for primary app content.
export default function Modal({ title, onClose, children, footer, width = 420 }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'var(--color-overlay-scrim)',
        backdropFilter: 'blur(var(--blur-md))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: `min(${width}px, 100%)`,
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-border-subtle)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-xl)',
          overflow: 'hidden',
        }}
      >
        {(title || onClose) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 20px',
              borderBottom: '1px solid var(--color-border-subtle)',
            }}
          >
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-md)', fontWeight: 'var(--font-weight-bold)', color: 'var(--text-primary)' }}>
              {title}
            </span>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                style={{
                  width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'var(--color-surface-3)', border: 'none', borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)', cursor: 'pointer',
                }}
              >
                <X size={16} />
              </button>
            )}
          </div>
        )}
        <div style={{ padding: 20 }}>{children}</div>
        {footer && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--color-border-subtle)' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
