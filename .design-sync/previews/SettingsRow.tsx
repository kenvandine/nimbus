import * as React from 'react'
import { Panel, SettingsRow, Button, Badge, StatusDot } from 'nimbus-ui'

// SettingsRow draws its own bottom divider, so it reads correctly stacked
// inside a Panel — which is how it's always used.
export const Rows = () => (
  <div style={{ width: 400 }}>
    <Panel>
      <SettingsRow label="Device name" sub="nimbus.local">
        <Button variant="soft" size="sm">Edit</Button>
      </SettingsRow>
      <SettingsRow label="Storage" sub="128 GB free of 512 GB">
        <Badge tone="info">40% used</Badge>
      </SettingsRow>
      <SettingsRow label="Automatic updates">
        <StatusDot tone="success" label="On" />
      </SettingsRow>
    </Panel>
  </div>
)
