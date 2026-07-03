import * as React from 'react'
import { Badge } from 'nimbus-ui'

export const Tones = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
    <Badge tone="accent">Featured</Badge>
    <Badge tone="info">Beta</Badge>
    <Badge tone="success">Installed</Badge>
    <Badge tone="warning">Update</Badge>
    <Badge tone="danger">Offline</Badge>
    <Badge tone="neutral">System</Badge>
  </div>
)

export const Casing = () => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
    <Badge tone="success">Running</Badge>
    <Badge tone="success" uppercase={false}>Running</Badge>
  </div>
)
