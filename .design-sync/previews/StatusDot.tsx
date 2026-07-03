import * as React from 'react'
import { StatusDot } from 'nimbus-ui'

export const WithLabels = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <StatusDot tone="success" label="Running" />
    <StatusDot tone="warning" label="Restarting" />
    <StatusDot tone="danger" label="Stopped" />
    <StatusDot tone="info" label="Updating" />
    <StatusDot tone="neutral" label="Not installed" />
  </div>
)

export const DotOnly = () => (
  <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
    <StatusDot tone="success" />
    <StatusDot tone="warning" />
    <StatusDot tone="danger" size={12} />
  </div>
)
