import * as React from 'react'
import { Button } from 'nimbus-ui'

export const Primary = () => <Button>Install app</Button>

export const Variants = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
    <Button variant="primary">Install</Button>
    <Button variant="soft">Details</Button>
    <Button variant="secondary">Cancel</Button>
    <Button variant="danger">Uninstall</Button>
    <Button variant="ghost">Skip</Button>
  </div>
)

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Button size="md">Medium</Button>
    <Button size="sm">Small</Button>
  </div>
)

export const States = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <Button loading>Installing</Button>
    <Button disabled>Unavailable</Button>
  </div>
)

export const FullWidth = () => (
  <div style={{ width: 260 }}>
    <Button fullWidth>Continue setup</Button>
  </div>
)
