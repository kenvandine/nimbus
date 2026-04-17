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

export default function DeviceInfo({ stats, apps }) {
  const running = apps?.filter(a => a.running).length ?? 0
  const installed = apps?.filter(a => a.installed).length ?? 0
  const updates = apps?.filter(a => a.update_available).length ?? 0

  return (
    <div style={styles.container}>
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
          <InfoRow label="Runtime" value="Docker + LXD" />
          <InfoRow label="App Catalogue" value="Umbrel App Store" />
        </div>
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
}
