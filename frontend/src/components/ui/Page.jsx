import PageHeader from './PageHeader.jsx'

// Full-screen routed page: header + content area. Replaces opening
// AppStore/Files/DeviceInfo/Settings/Terminal inside a "Window" modal.
export default function Page({ title, headerActions, noPad = false, children }) {
  return (
    <div style={styles.page}>
      <PageHeader title={title}>{headerActions}</PageHeader>
      <div style={{ ...styles.content, ...(noPad ? styles.contentNoPad : {}) }}>{children}</div>
    </div>
  )
}

const styles = {
  page: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--color-bg-canvas)',
  },
  content: {
    flex: 1,
    overflowY: 'auto',
    padding: '20px 24px',
  },
  contentNoPad: {
    padding: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
}
