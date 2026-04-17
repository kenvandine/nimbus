export default function SystemStats({ stats }) {
  if (!stats) return null

  const bars = [
    { label: 'CPU', value: stats.cpu_pct, color: '#4fc3f7' },
    { label: 'RAM', value: stats.mem_pct, color: '#81d4fa' },
    { label: 'Disk', value: stats.disk_pct, color: '#b3e5fc' },
  ]

  return (
    <div style={styles.container}>
      <span style={styles.appCount}>☁ {stats.app_count} app{stats.app_count !== 1 ? 's' : ''} installed</span>
      <div style={styles.bars}>
        {bars.map(({ label, value, color }) => (
          <div key={label} style={styles.barGroup}>
            <span style={styles.barLabel}>{label}</span>
            <div style={styles.barTrack}>
              <div
                style={{
                  ...styles.barFill,
                  width: `${value}%`,
                  background: color,
                  opacity: value > 80 ? 1 : 0.75,
                }}
              />
            </div>
            <span style={styles.barValue}>{Math.round(value)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const styles = {
  container: {
    display: 'flex',
    alignItems: 'center',
    gap: '24px',
    padding: '12px 24px',
    background: 'rgba(255,255,255,0.06)',
    backdropFilter: 'blur(8px)',
    borderBottom: '1px solid rgba(255,255,255,0.1)',
    flexWrap: 'wrap',
  },
  appCount: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: '13px',
    fontWeight: 500,
    whiteSpace: 'nowrap',
  },
  bars: {
    display: 'flex',
    gap: '20px',
    flexWrap: 'wrap',
  },
  barGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  barLabel: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: '12px',
    width: '32px',
    textAlign: 'right',
  },
  barTrack: {
    width: '80px',
    height: '6px',
    background: 'rgba(255,255,255,0.12)',
    borderRadius: '3px',
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: '3px',
    transition: 'width 0.6s ease',
  },
  barValue: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: '12px',
    width: '34px',
  },
}
