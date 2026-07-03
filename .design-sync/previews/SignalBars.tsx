import * as React from 'react'
import { SignalBars } from 'nimbus-ui'

const Cell = ({ strength, label }) => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
    <SignalBars strength={strength} />
    <span style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-tertiary)' }}>{label}</span>
  </div>
)

export const Strengths = () => (
  <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end' }}>
    <Cell strength={100} label="Excellent" />
    <Cell strength={70} label="Good" />
    <Cell strength={40} label="Fair" />
    <Cell strength={15} label="Weak" />
  </div>
)
