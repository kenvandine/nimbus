import * as React from 'react'
import { PinPad, PinDots } from 'nimbus-ui'

// The full lock-screen composition: dots indicator above the numeric keypad,
// which is how PinPad is used in Oobe / ScreenLock / Settings.
export const LockScreen = () => (
  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
    <PinDots length={4} value="12" />
    <PinPad value="12" onChange={() => {}} />
  </div>
)

export const Compact = () => <PinPad value="" onChange={() => {}} size={56} />
