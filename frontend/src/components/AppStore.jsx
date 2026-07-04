import { useState } from 'react'
import { RefreshCw, ArrowUp } from 'lucide-react'
import AppCard from './AppCard.jsx'
import AppModal from './AppModal.jsx'
import { refreshCatalog } from '../api.js'
import Button from './ui/Button.jsx'
import { useTranslation } from '../i18n.jsx'

export default function AppStore({ apps, onRefresh, onOpenDetail, activeInstalls = [] }) {
  const { t } = useTranslation()
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
          placeholder={t('app_store_search', 'Search apps…')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="store-search"
          style={styles.search}
        />
        <Button
          variant={showUpdatesOnly ? 'soft' : 'secondary'}
          size="sm"
          onClick={() => setShowUpdatesOnly(v => !v)}
          title={t('show_updates_only', 'Show apps with updates only')}
        >
          <ArrowUp size={13} /> {t('app_store_updates', 'Updates')}{updatableCount > 0 && <span style={styles.filterBadge}>{updatableCount}</span>}
        </Button>
        <button
          style={{ ...styles.advancedBtn, ...(showUnsupported ? styles.advancedBtnActive : {}) }}
          onClick={() => setShowUnsupported(v => !v)}
          title={t('show_untested_apps', 'Show untested apps')}
        >
          {t('advanced', 'Advanced')}
        </button>
        <Button variant="secondary" size="sm" onClick={handleRefreshCatalog} disabled={refreshing} loading={refreshing} title={t('refresh_app_catalog', 'Refresh app catalog')}>
          {refreshing ? t('app_store_refreshing', 'Refreshing…') : <><RefreshCw size={13} /> {t('app_store_refresh', 'Refresh Store')}</>}
        </Button>
        <span style={styles.count}>{filtered.length} {filtered.length === 1 ? t('app_singular', 'app') : t('app_plural', 'apps')}</span>
      </div>

      {showUnsupported && filtered.length > 0 && (
        <p style={styles.advancedNotice}>
          {t('advanced_notice', 'Advanced mode — these apps are untested on this appliance and may not work correctly.')}
        </p>
      )}

      {filtered.length === 0 ? (
        <p style={styles.empty}>
          {showUpdatesOnly ? t('apps_up_to_date', 'All installed apps are up to date.') : t('app_store_no_apps', 'No apps found matching search.')}
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
  container: { display: 'flex', flexDirection: 'column', gap: '16px', fontFamily: 'var(--font-sans)' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '10px' },
  search: {
    flex: 1,
    minHeight: 38,
    padding: '9px 14px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--color-border-strong)',
    background: 'var(--color-surface-2)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
    fontSize: '14px',
    outline: 'none',
  },
  filterBadge: {
    background: 'var(--color-warning)',
    color: 'var(--color-text-on-accent)',
    borderRadius: '8px',
    padding: '1px 6px',
    fontSize: '11px',
    fontWeight: 700,
    marginLeft: 4,
  },
  count: { color: 'var(--text-tertiary)', fontSize: '13px', whiteSpace: 'nowrap' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '14px' },
  empty: { color: 'var(--text-tertiary)', textAlign: 'center', marginTop: '40px' },
  advancedBtn: {
    display: 'flex', alignItems: 'center', gap: 6,
    height: 34, padding: '0 14px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--color-border-strong)',
    background: 'var(--color-surface-3)',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-sans)',
    fontSize: '13px',
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  advancedBtnActive: {
    background: 'rgba(186,141,201,0.16)',
    border: '1px solid rgba(186,141,201,0.4)',
    color: '#d9b8e3',
  },
  advancedNotice: {
    color: '#d9b8e3',
    fontSize: '13px',
    margin: 0,
    padding: '8px 14px',
    background: 'rgba(186,141,201,0.08)',
    border: '1px solid rgba(186,141,201,0.22)',
    borderRadius: 'var(--radius-sm)',
    fontFamily: 'var(--font-sans)',
  },
}
