import { useNavigate } from 'react-router-dom'
import { openApp } from '../utils.js'
import AppTile from './ui/AppTile.jsx'
import Badge from './ui/Badge.jsx'
import Button from './ui/Button.jsx'
import { useTranslation } from '../i18n.jsx'

export default function Home({ apps, loading, error, errorMessage, setupState, onOpenDetail, onOpenLogs, onServiceAction, onUninstall }) {
  const { t } = useTranslation()
  const runningApps = apps.filter(a => a.running)
  const navigate = useNavigate()

  function handleAction(action, app) {
    if (action === 'open' && app.open_url) openApp(app.open_url, { name: app.name, id: app.id })
    else if (action === 'info') onOpenDetail(app)
    else if (action === 'logs') onOpenLogs(app)
    else if (action === 'uninstall') onUninstall(app)
    else if (['start', 'stop', 'restart'].includes(action)) onServiceAction(app, action)
  }

  return (
    <div style={styles.area}>
      {loading && <div style={styles.loadingMsg}>{t('loading', 'Loading…')}</div>}
      {error && !loading && <div style={styles.errorMsg}>{errorMessage}</div>}

      {!loading && !error && setupState && !setupState.ready && (
        <div style={styles.setupCard}>
          <Badge tone={setupState.error ? 'danger' : 'accent'}>{setupState.error ? t('home_setup_error', 'Setup Error') : t('home_setup_in_progress', 'Setup in Progress')}</Badge>
          <h2 style={styles.setupTitle}>{setupState.title}</h2>
          <p style={styles.setupMessage}>{setupState.message}</p>
          <p style={styles.setupHint}>
            {t('home_setup_hint', 'Nimbus will be ready once the managed LXD container is running and fully bootstrapped.')}
          </p>
        </div>
      )}

      {!loading && !error && (!setupState || setupState.ready) && (
        runningApps.length === 0 ? (
          <div style={styles.emptyState}>
            <div style={styles.emptyTitle}>{t('home_empty_title', 'No apps running yet')}</div>
            <p style={styles.emptyMessage}>{t('home_empty_desc', 'Open the App Store to install Immich, Nextcloud, or a personal AI agent.')}</p>
            <Button variant="primary" onClick={() => navigate('/app-store')}>{t('home_browse_store', 'Browse the App Store')}</Button>
          </div>
        ) : (
          <div style={styles.grid}>
            {runningApps.map(app => (
              <AppTile key={app.id} app={app} onOpen={() => handleAction('open', app)} onAction={handleAction} />
            ))}
          </div>
        )
      )}
    </div>
  )
}

const styles = {
  area: {
    flex: 1,
    minHeight: 0,
    padding: 24,
    overflowY: 'auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, 96px)',
    justifyContent: 'center',
    gap: 12,
  },
  loadingMsg: {
    color: 'var(--text-tertiary)',
    fontSize: 14,
    fontFamily: 'var(--font-sans)',
    margin: 'auto',
  },
  errorMsg: {
    color: 'var(--color-danger-soft-text)',
    fontSize: 13,
    fontFamily: 'var(--font-sans)',
    margin: 'auto',
    background: 'var(--color-danger-soft-bg)',
    padding: '12px 20px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid var(--color-danger-soft-border)',
  },
  setupCard: {
    width: 'min(560px, 100%)',
    background: 'var(--color-surface-2)',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-xl)',
    padding: '28px 30px',
    boxShadow: 'var(--shadow-lg)',
    backdropFilter: 'blur(var(--blur-lg))',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 8,
  },
  setupTitle: {
    margin: '10px 0 4px',
    fontSize: 26,
    lineHeight: 1.15,
    fontWeight: 'var(--font-weight-bold)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-sans)',
  },
  setupMessage: {
    margin: 0,
    fontSize: 15,
    lineHeight: 1.5,
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-sans)',
  },
  setupHint: {
    margin: '4px 0 0',
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-sans)',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    gap: 8,
    maxWidth: 340,
  },
  emptyTitle: {
    fontFamily: 'var(--font-sans)',
    fontSize: 20,
    fontWeight: 'var(--font-weight-bold)',
    color: 'var(--text-primary)',
  },
  emptyMessage: {
    fontFamily: 'var(--font-sans)',
    fontSize: 14,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
    margin: '0 0 12px',
  },
}
