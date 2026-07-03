import * as React from 'react'
import { SettingsSection, SettingsRow, Button, StatusDot, Badge } from 'nimbus-ui'

const WifiIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12.5a10 10 0 0 1 14 0" />
    <path d="M8.5 16a5 5 0 0 1 7 0" />
    <line x1="12" y1="19.5" x2="12" y2="19.5" />
  </svg>
)

export const Network = () => (
  <div style={{ width: 420 }}>
    <SettingsSection icon={WifiIcon} title="Network">
      <SettingsRow label="Wi-Fi" sub="Connected to Nimbus-5G">
        <StatusDot tone="success" label="Online" />
      </SettingsRow>
      <SettingsRow label="Ethernet" sub="Cable not detected">
        <Badge tone="neutral">Off</Badge>
      </SettingsRow>
      <SettingsRow label="Hostname" sub="nimbus.local">
        <Button variant="soft" size="sm">Change</Button>
      </SettingsRow>
    </SettingsSection>
  </div>
)
