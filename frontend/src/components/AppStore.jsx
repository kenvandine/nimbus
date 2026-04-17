import { useState } from 'react'
import AppCard from './AppCard.jsx'
import AppModal from './AppModal.jsx'

export default function AppStore({ apps, onRefresh, onOpenDetail }) {
  const [search, setSearch] = useState('')
  const [showUpdatesOnly, setShowUpdatesOnly] = useState(false)
  const [selectedApp, setSelectedApp] = useState(null)

  const updatableCount = apps.filter(a => a.update_available).length

  function handleOpenDetail(app) {
    if (onOpenDetail) onOpenDetail(app)
    else setSelectedApp(app)
  }

  const filtered = apps.filter(app => {
    if (showUpdatesOnly && !app.update_available) return false
    const q = search.toLowerCase()
    return (
      app.name.toLowerCase().includes(q) ||
      app.tagline.toLowerCase().includes(q) ||
      app.categories.some(c => c.toLowerCase().includes(q))
    )
  })

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <input
          type="search"
          placeholder="Search apps…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={styles.search}
        />
        <button
          style={{ ...styles.filterBtn, ...(showUpdatesOnly ? styles.filterBtnActive : {}) }}
          onClick={() => setShowUpdatesOnly(v => !v)}
          title="Show apps with updates only"
        >
          ⬆ Updates{updatableCount > 0 && <span style={styles.filterBadge}>{updatableCount}</span>}
        </button>
        <span style={styles.count}>{filtered.length} app{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {filtered.length === 0 ? (
        <p style={styles.empty}>
          {showUpdatesOnly ? 'All installed apps are up to date.' : `No apps match "${search}"`}
        </p>
      ) : (
        <div style={styles.grid}>
          {filtered.map(app => (
            <AppCard key={app.id} app={app} onRefresh={onRefresh} onOpenDetail={handleOpenDetail} />
          ))}
        </div>
      )}

      {!onOpenDetail && (
        <AppModal
          app={selectedApp}
          onClose={() => setSelectedApp(null)}
          onRefresh={() => { onRefresh(); setSelectedApp(null) }}
        />
      )}
    </div>
  )
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', gap: '16px' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '10px' },
  search: {
    flex: 1,
    padding: '9px 14px',
    borderRadius: '10px',
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(255,255,255,0.08)',
    color: 'white',
    fontSize: '14px',
    outline: 'none',
  },
  filterBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 14px',
    borderRadius: '10px',
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(255,255,255,0.06)',
    color: 'rgba(255,255,255,0.55)',
    fontSize: '13px',
    fontWeight: 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  filterBtnActive: {
    background: 'rgba(255,152,0,0.18)',
    border: '1px solid rgba(255,152,0,0.45)',
    color: '#ffb74d',
  },
  filterBadge: {
    background: '#ff9800',
    color: '#0a1628',
    borderRadius: '8px',
    padding: '1px 6px',
    fontSize: '11px',
    fontWeight: 700,
  },
  count: { color: 'rgba(255,255,255,0.35)', fontSize: '13px', whiteSpace: 'nowrap' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '14px' },
  empty: { color: 'rgba(255,255,255,0.4)', textAlign: 'center', marginTop: '40px' },
}
