import { useState } from 'react'
import AppCard from './AppCard.jsx'
import AppModal from './AppModal.jsx'

export default function AppStore({ apps, onRefresh }) {
  const [search, setSearch] = useState('')
  const [selectedApp, setSelectedApp] = useState(null)

  const filtered = apps.filter(app => {
    const q = search.toLowerCase()
    return (
      app.name.toLowerCase().includes(q) ||
      app.tagline.toLowerCase().includes(q) ||
      app.categories.some(c => c.toLowerCase().includes(q))
    )
  })

  return (
    <div style={styles.container}>
      <div style={styles.searchRow}>
        <input
          type="search"
          placeholder="Search apps…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={styles.search}
        />
        <span style={styles.count}>{filtered.length} app{filtered.length !== 1 ? 's' : ''}</span>
      </div>
      {filtered.length === 0 ? (
        <p style={styles.empty}>No apps match "{search}"</p>
      ) : (
        <div style={styles.grid}>
          {filtered.map(app => (
            <AppCard key={app.id} app={app} onRefresh={onRefresh} onOpenDetail={setSelectedApp} />
          ))}
        </div>
      )}
      <AppModal
        app={selectedApp}
        onClose={() => setSelectedApp(null)}
        onRefresh={() => { onRefresh(); setSelectedApp(null) }}
      />
    </div>
  )
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  searchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
  },
  search: {
    flex: 1,
    padding: '10px 16px',
    borderRadius: '10px',
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(255,255,255,0.08)',
    color: 'white',
    fontSize: '14px',
    outline: 'none',
  },
  count: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: '13px',
    whiteSpace: 'nowrap',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: '16px',
  },
  empty: {
    color: 'rgba(255,255,255,0.4)',
    textAlign: 'center',
    marginTop: '40px',
  },
}
