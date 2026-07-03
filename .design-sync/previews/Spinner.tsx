import * as React from 'react'
import { Spinner } from 'nimbus-ui'

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
    <Spinner size={16} />
    <Spinner size={24} />
    <Spinner size={36} />
  </div>
)

export const Colors = () => (
  <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
    <Spinner size={28} />
    <Spinner size={28} color="var(--color-info)" />
    <Spinner size={28} color="var(--text-primary)" thickness={3} />
  </div>
)
