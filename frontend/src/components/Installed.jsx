import { useState } from 'react'
import AppCard from './AppCard.jsx'
import AppModal from './AppModal.jsx'

export default function Installed({ apps, onRefresh }) {
  const [selectedApp, setSelectedApp] = useState(null)
  const installed = apps.filter(a => a.installed)

  if (installed.length === 0) {
    return (
      <div style={styles.empty}>
        <p>No apps installed yet.</p>
        <p style={styles.hint}>Head to the App Store tab to install your first app.</p>
      </div>
    )
  }

  return (
    <>
      <div style={styles.grid}>
        {installed.map(app => (
          <AppCard key={app.id} app={app} onRefresh={onRefresh} onOpenDetail={setSelectedApp} />
        ))}
      </div>
      <AppModal
        app={selectedApp}
        onClose={() => setSelectedApp(null)}
        onRefresh={() => { onRefresh(); setSelectedApp(null) }}
      />
    </>
  )
}

const styles = {
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: '16px',
  },
  empty: {
    textAlign: 'center',
    color: 'rgba(255,255,255,0.5)',
    marginTop: '60px',
    lineHeight: '1.8',
  },
  hint: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: '13px',
  },
}
