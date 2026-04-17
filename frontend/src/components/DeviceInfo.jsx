function Gauge({ label, value, color }) {
  return (
    <div style={styles.gaugeWrap}>
      <div style={styles.gaugeHeader}>
        <span style={styles.gaugeLabel}>{label}</span>
        <span style={styles.gaugeValue}>{Math.round(value)}%</span>
      </div>
      <div style={styles.track}>
        <div style={{ ...styles.fill, width: `${value}%`, background: color }} />
      </div>
    </div>
  )
}

function InfoRow({ label, value }) {
  return (
    <div style={styles.infoRow}>
      <span style={styles.infoLabel}>{label}</span>
      <span style={styles.infoValue}>{value}</span>
    </div>
  )
}

function formatBootstrapState(state) {
  const labels = {
    idle: 'Waiting to start',
    'ensuring-profile': 'Configuring LXD profile',
    'ensuring-container': 'Creating managed container',
    'installing-runtime': 'Installing container runtime',
    'pushing-agent': 'Copying Nimbus services',
    'installing-agent-python': 'Installing Python dependencies',
    'starting-agent': 'Starting Nimbus agent',
    ready: 'Ready',
    error: 'Error',
  }
  return labels[state] || state || 'Unknown'
}

export default function DeviceInfo({ stats, apps }) {
  const running = apps?.filter(a => a.running).length ?? 0
  const installed = apps?.filter(a => a.installed).length ?? 0
  const updates = apps?.filter(a => a.update_available).length ?? 0
  const setupPending = stats?.control_mode === 'lxd' && (!stats?.container_bootstrapped || stats?.container_status !== 'running' || stats?.bootstrap_state !== 'ready')
  const firstSetup = !stats?.container_bootstrapped

  return (
    <div style={styles.container}>
      {setupPending && (
        <section style={styles.setupBanner}>
          <div style={styles.setupBannerTitle}>{firstSetup ? 'Nimbus is still being set up' : 'Nimbus is still starting'}</div>
          <div style={styles.setupBannerText}>
            {stats?.bootstrap_error
              ? `Setup failed: ${stats.bootstrap_error}`
              : `${formatBootstrapState(stats?.bootstrap_state)}. ${firstSetup ? 'The managed LXD container is not ready for normal use yet.' : 'Nimbus is reconnecting to the managed container and restoring app state.'}`}
          </div>
        </section>
      )}

      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>System Resources</h3>
        {stats ? (
          <>
            <Gauge label="CPU" value={stats.cpu_pct} color="#4fc3f7" />
            <Gauge label="Memory" value={stats.mem_pct} color="#81d4fa" />
            <Gauge label="Disk" value={stats.disk_pct} color="#b3e5fc" />
          </>
        ) : (
          <p style={styles.muted}>Loading…</p>
        )}
      </section>

      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>Apps</h3>
        <div style={styles.statGrid}>
          <StatTile value={installed} label="Installed" color="#4fc3f7" />
          <StatTile value={running} label="Running" color="#4caf50" />
          <StatTile value={updates} label="Updates" color="#ff9800" />
        </div>
      </section>

      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>Platform</h3>
        <div style={styles.infoTable}>
          <InfoRow label="Service" value="Nimbus v0.1.0" />
          <InfoRow label="Runtime" value={stats?.control_mode === 'lxd' ? 'Strict snap controller + LXD' : 'Docker + LXD'} />
          <InfoRow label="App Catalogue" value="Umbrel App Store" />
          {stats?.container_name && <InfoRow label="Managed Container" value={stats.container_name} />}
          {stats?.container_status && <InfoRow label="Container State" value={stats.container_status} />}
          {stats?.container_ip && <InfoRow label="Container IP" value={stats.container_ip} />}
          {stats?.bootstrap_state && <InfoRow label="Bootstrap" value={formatBootstrapState(stats.bootstrap_state)} />}
        </div>
        {stats?.bootstrap_error && (
          <p style={styles.errorText}>Container bootstrap error: {stats.bootstrap_error}</p>
        )}
      </section>
    </div>
  )
}

function StatTile({ value, label, color }) {
  return (
    <div style={styles.tile}>
      <span style={{ ...styles.tileValue, color }}>{value}</span>
      <span style={styles.tileLabel}>{label}</span>
    </div>
  )
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', gap: '28px' },
  setupBanner: {
    padding: '16px 18px',
    borderRadius: '14px',
    background: 'rgba(79,195,247,0.12)',
    border: '1px solid rgba(79,195,247,0.24)',
  },
  setupBannerTitle: {
    color: '#b3e5fc',
    fontSize: '14px',
    fontWeight: 700,
    marginBottom: '6px',
  },
  setupBannerText: {
    color: 'rgba(255,255,255,0.76)',
    fontSize: '13px',
    lineHeight: 1.5,
  },
  section: {},
  sectionTitle: {
    color: 'rgba(255,255,255,0.38)',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    margin: '0 0 14px',
  },
  gaugeWrap: { marginBottom: '14px' },
  gaugeHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' },
  gaugeLabel: { color: 'rgba(255,255,255,0.65)', fontSize: '13px' },
  gaugeValue: { color: 'rgba(255,255,255,0.45)', fontSize: '13px' },
  track: { height: '8px', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', overflow: 'hidden' },
  fill: { height: '100%', borderRadius: '4px', transition: 'width 0.6s ease' },
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '12px' },
  tile: {
    background: 'rgba(255,255,255,0.06)',
    borderRadius: '12px',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
  },
  tileValue: { fontSize: '28px', fontWeight: 700, lineHeight: 1 },
  tileLabel: { color: 'rgba(255,255,255,0.45)', fontSize: '12px' },
  infoTable: {
    background: 'rgba(255,255,255,0.04)',
    borderRadius: '12px',
    overflow: 'hidden',
  },
  infoRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '11px 16px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  infoLabel: { color: 'rgba(255,255,255,0.45)', fontSize: '13px' },
  infoValue: { color: 'rgba(255,255,255,0.8)', fontSize: '13px', fontWeight: 500 },
  muted: { color: 'rgba(255,255,255,0.3)', fontSize: '13px' },
  errorText: { color: '#ff8a80', fontSize: '12px', margin: '10px 0 0' },
}
