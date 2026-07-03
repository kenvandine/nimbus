import * as React from 'react'
import { AppTile } from 'nimbus-ui'

const icon = (bg: string, glyph: string) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><rect width="60" height="60" rx="16" fill="${bg}"/><text x="30" y="41" font-family="sans-serif" font-size="30" font-weight="700" text-anchor="middle" fill="#fff">${glyph}</text></svg>`,
  )

export const Default = () => (
  <AppTile
    app={{ id: 'immich', name: 'Immich', icon: icon('#F0813A', 'I'), open_url: 'http://x', has_service: true, running: true, is_system: false }}
    onOpen={() => {}}
    onAction={() => {}}
  />
)

export const UpdateAvailable = () => (
  <AppTile
    app={{ id: 'jellyfin', name: 'Jellyfin', icon: icon('#56ABC6', 'J'), open_url: 'http://x', has_service: true, running: true, is_system: false, update_available: true }}
    onOpen={() => {}}
    onAction={() => {}}
  />
)

export const SystemApp = () => (
  <AppTile
    app={{ id: 'files', name: 'Files', icon: icon('#6FBF73', 'F'), open_url: 'http://x', is_system: true }}
    onOpen={() => {}}
    onAction={() => {}}
  />
)
