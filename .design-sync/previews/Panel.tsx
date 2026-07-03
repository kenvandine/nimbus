import * as React from 'react'
import { Panel } from 'nimbus-ui'

export const Basic = () => (
  <div style={{ width: 360 }}>
    <Panel>
      <div style={{ padding: 16, color: 'var(--text-primary)', fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
        Panel is the base surface for grouped content — settings sections, info
        tables and cards are all built on it.
      </div>
    </Panel>
  </div>
)
