import { useState } from 'react'
import AppCard from './AppCard.jsx'
import AppModal from './AppModal.jsx'
import { refreshCatalog } from '../api.js'

export default function AppStore({ apps, onRefresh, onOpenDetail, activeInstalls = [] }) {
  const [search, setSearch] = useState('')
  const [showUpdatesOnly, setShowUpdatesOnly] = useState(false)
  const [showUnsupported, setShowUnsupported] = useState(false)
  const [selectedApp, setSelectedApp] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  const updatableCount = apps.filter(a => a.update_available).length

  async function handleRefreshCatalog() {
    setRefreshing(true)
    try {
      await refreshCatalog()
      onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  function handleOpenDetail(app) {
    if (onOpenDetail) onOpenDetail(app)
    else setSelectedApp(app)
  }

  const filtered = apps.filter(app => {
    if (!showUnsupported && !app.supported) return false
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
      <div className="store-toolbar" style={styles.toolbar}>
        <input
          type="search"
          placeholder="Search apps…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="store-search"
          style={styles.search}
        />
        <button
          style={{ ...styles.filterBtn, ...(showUpdatesOnly ? styles.filterBtnActive : {}) }}
          onClick={() => setShowUpdatesOnly(v => !v)}
          title="Show apps with updates only"
        >
          ⬆ Updates{updatableCount > 0 && <span style={styles.filterBadge}>{updatableCount}</span>}
        </button>
        <button
          style={{ ...styles.filterBtn, ...(showUnsupported ? styles.filterBtnAdvanced : {}) }}
          onClick={() => setShowUnsupported(v => !v)}
          title="Show untested apps"
        >
          Advanced
        </button>
        <button
          style={{ ...styles.filterBtn, ...(refreshing ? styles.filterBtnDisabled : {}) }}
          onClick={handleRefreshCatalog}
          disabled={refreshing}
          title="Refresh app catalog"
        >
          {refreshing ? <><span style={styles.spinner} /> Refreshing…</> : '↻ Refresh'}
        </button>
        <span style={styles.count}>{filtered.length} app{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {showUnsupported && filtered.length > 0 && (
        <p style={styles.advancedNotice}>
          Advanced mode — these apps are untested on this appliance and may not work correctly.
        </p>
      )}

      {filtered.length === 0 ? (
        <p style={styles.empty}>
          {showUpdatesOnly ? 'All installed apps are up to date.' : `No apps match "${search}"`}
        </p>
      ) : (
        <div style={styles.grid}>
          {filtered.map(app => (
            <AppCard
              key={app.id}
              app={app}
              onRefresh={onRefresh}
              onOpenDetail={handleOpenDetail}
              isInstalling={activeInstalls.includes(app.id)}
            />
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
      <style>{`
        @media (max-width: 600px) {
          .store-toolbar {
            flex-wrap: wrap !important;
            gap: 8px !important;
          }
          .store-search {
            flex: 1 1 100% !important;
            width: 100% !important;
          }
        }
      `}</style>
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
  filterBtnAdvanced: {
    background: 'rgba(156,39,176,0.18)',
    border: '1px solid rgba(156,39,176,0.45)',
    color: '#ce93d8',
  },
  filterBtnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  spinner: {
    display: 'inline-block', width: '10px', height: '10px',
    border: '2px solid rgba(255,255,255,0.3)', borderTopColor: 'white',
    borderRadius: '50%', animation: 'spin 0.7s linear infinite',
    marginRight: '4px',
  },
  advancedNotice: {
    color: 'rgba(206,147,216,0.8)',
    fontSize: '13px',
    margin: 0,
    padding: '8px 14px',
    background: 'rgba(156,39,176,0.08)',
    border: '1px solid rgba(156,39,176,0.2)',
    borderRadius: '10px',
  },
}
