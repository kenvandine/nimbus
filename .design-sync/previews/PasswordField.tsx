import * as React from 'react'
import { PasswordField } from 'nimbus-ui'

export const Filled = () => (
  <div style={{ width: 320 }}>
    <PasswordField value="nimbus-wifi-2024" onChange={() => {}} />
  </div>
)

export const Placeholder = () => (
  <div style={{ width: 320 }}>
    <PasswordField value="" onChange={() => {}} placeholder="Wi-Fi password" />
  </div>
)
