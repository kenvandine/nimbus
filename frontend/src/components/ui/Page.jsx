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
    minHeight: 0,
    overflowY: 'auto',
    padding: '20px 24px',
    // Own compositing layer, isolated from PageHeader's backdrop-filter sibling.
    // Without this, Chromium's GPU-accelerated compositor can fail to
    // re-attach wheel-scroll hit-testing to this region after the route's
    // DOM subtree is torn down and rebuilt on client-side navigation — touch
    // scrolling still works (separate input path) but the mouse wheel goes
    // dead until a full page reload rebuilds the layer tree from scratch.
    isolation: 'isolate',
    willChange: 'transform',
  },
  contentNoPad: {
    padding: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
}
