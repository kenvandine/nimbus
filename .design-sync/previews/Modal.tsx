import * as React from 'react'
import { Modal, Button } from 'nimbus-ui'

// Modal is a full-screen fixed overlay. The min-height wrapper gives the card
// real height so the translucent scrim fills a dark canvas (from the preview
// provider) rather than collapsing onto the tool's white card chrome.
export const Confirm = () => (
  <div style={{ minHeight: 360 }}>
    <Modal
      title="Uninstall Immich?"
      onClose={() => {}}
      footer={
        <>
          <Button variant="secondary" size="sm">Cancel</Button>
          <Button variant="danger" size="sm">Uninstall</Button>
        </>
      }
    >
      <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', lineHeight: 1.5 }}>
        This removes Immich and its container from your device. Photos already backed
        up to the external drive are kept.
      </div>
    </Modal>
  </div>
)
