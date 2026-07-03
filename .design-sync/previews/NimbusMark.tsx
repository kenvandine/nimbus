import * as React from 'react'
import { NimbusMark } from 'nimbus-ui'

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
    <NimbusMark size={28} />
    <NimbusMark size={48} />
    <NimbusMark size={72} />
  </div>
)

export const WithAndWithoutBackground = () => (
  <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
    <NimbusMark size={56} />
    <NimbusMark size={56} background={false} />
  </div>
)
