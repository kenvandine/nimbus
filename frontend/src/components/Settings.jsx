const SECTIONS = [
  {
    title: 'Network',
    icon: '📡',
    items: ['Wi-Fi', 'Ethernet', 'Firewall rules', 'DNS settings'],
  },
  {
    title: 'System Updates',
    icon: '⬆️',
    items: ['OS updates', 'Nimbus updates', 'Update schedule'],
  },
  {
    title: 'Security',
    icon: '🔒',
    items: ['UI authentication', 'TLS / HTTPS', 'SSH access'],
  },
  {
    title: 'Storage',
    icon: '💾',
    items: ['Disk management', 'Backup configuration', 'App data paths'],
  },
  {
    title: 'About',
    icon: '☁',
    items: ['Nimbus version', 'Licences', 'Source code'],
  },
]

export default function Settings() {
  return (
    <div style={styles.container}>
      <div style={styles.notice}>
        <span style={styles.noticeIcon}>🚧</span>
        <div>
          <strong style={{ color: 'white' }}>Settings coming soon</strong>
          <p style={styles.noticeSub}>These features are planned for a future release.</p>
        </div>
      </div>

      {SECTIONS.map(section => (
        <div key={section.title} style={styles.section}>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionIcon}>{section.icon}</span>
            <span style={styles.sectionTitle}>{section.title}</span>
          </div>
          <div style={styles.itemList}>
            {section.items.map(item => (
              <div key={item} style={styles.item}>
                <span style={styles.itemLabel}>{item}</span>
                <span style={styles.pill}>Soon</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', gap: '20px' },
  notice: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    background: 'rgba(255,152,0,0.1)',
    border: '1px solid rgba(255,152,0,0.25)',
    borderRadius: '12px',
    padding: '16px 20px',
    marginBottom: '8px',
  },
  noticeIcon: { fontSize: '24px', flexShrink: 0 },
  noticeSub: { margin: '4px 0 0', color: 'rgba(255,255,255,0.5)', fontSize: '13px' },
  section: {
    background: 'rgba(255,255,255,0.04)',
    borderRadius: '12px',
    overflow: 'hidden',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '12px 16px',
    borderBottom: '1px solid rgba(255,255,255,0.07)',
    background: 'rgba(255,255,255,0.03)',
  },
  sectionIcon: { fontSize: '16px' },
  sectionTitle: { color: 'rgba(255,255,255,0.7)', fontWeight: 600, fontSize: '13px' },
  itemList: {},
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '11px 16px',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  itemLabel: { color: 'rgba(255,255,255,0.45)', fontSize: '13px' },
  pill: {
    background: 'rgba(255,255,255,0.08)',
    color: 'rgba(255,255,255,0.3)',
    fontSize: '10px',
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: '10px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
}
