import * as React from 'react'

// Preview-only wrapper — NOT part of the Nimbus UI public API.
//
// Nimbus is a DARK-THEME design system: components style themselves with
// translucent light-on-dark tokens (--color-surface-*, near-white --text-*,
// the soft/ghost/secondary button variants). On the design tool's default
// white preview card those wash out or vanish entirely. This wrapper puts
// every preview on the Nimbus dark canvas (--color-bg-canvas) so each card
// renders the way the component is actually meant to look.
//
// Wired via cfg.provider so it wraps every story automatically; it never
// appears in a real design built with the DS.
export function NimbusPreviewTheme({ children }) {
  return React.createElement(
    'div',
    {
      style: {
        background: 'var(--color-bg-canvas)',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
        padding: 24,
        borderRadius: 12,
      },
    },
    children,
  )
}
