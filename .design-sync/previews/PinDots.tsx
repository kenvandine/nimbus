import * as React from 'react'
import { PinDots } from 'nimbus-ui'

export const Progress = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
    <PinDots length={4} value="" />
    <PinDots length={4} value="12" />
    <PinDots length={4} value="1234" />
  </div>
)

export const SixDigit = () => <PinDots length={6} value="1234" />
