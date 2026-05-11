import { useCallback, useEffect, useState } from 'react'
import { listFiles, readFile } from '../api.js'
import FileEditor from './FileEditor.jsx'

function fileIcon(entry) {
  if (entry.is_dir) return '📁'
  switch (entry.mime_hint) {
    case 'markdown':   return '📝'
    case 'python':     return '🐍'
    case 'javascript':
    case 'typescript': return '🟨'
    case 'html':       return '🌐'
    case 'css':        return '🎨'
    case 'json':       return '🗂️'
    case 'yaml':       return '⚙️'
    case 'rust':       return '🦀'
    case 'shell':      return '💻'
    case 'sql':        return '🗄️'
    default:           return '📄'
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function Breadcrumb({ path, onNavigate }) {
  const parts = path.split('/').filter(Boolean)
  const crumbs = [{ label: '~', path: '/' }]
  parts.forEach((p, i) => {
    crumbs.push({ label: p, path: '/' + parts.slice(0, i + 1).join('/') })
  })

  return (
    <div style={bcStyles.wrap}>
      {crumbs.map((c, i) => (
        <span key={c.path} style={bcStyles.crumbGroup}>
          {i > 0 && <span style={bcStyles.sep}>/</span>}
          <button
            style={{ ...bcStyles.crumb, ...(i === crumbs.length - 1 ? bcStyles.crumbActive : {}) }}
            onClick={() => onNavigate(c.path)}
            disabled={i === crumbs.length - 1}
          >
            {c.label}
          </button>
        </span>
      ))}
    </div>
  )
}

const bcStyles = {
  wrap: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '2px',
    padding: '8px 14px',
    borderBottom: '1px solid rgba(255,255,255,0.07)',
    flexShrink: 0,
  },
  crumbGroup: { display: 'flex', alignItems: 'center' },
  sep: { color: 'rgba(255,255,255,0.2)', padding: '0 3px', fontSize: '12px' },
  crumb: {
    background: 'none',
    border: 'none',
    color: 'rgba(79,195,247,0.85)',
    fontSize: '12px',
    fontFamily: 'monospace',
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: '4px',
  },
  crumbActive: {
    color: 'rgba(255,255,255,0.7)',
    cursor: 'default',
  },
}

function FileGrid({ entries, onNavigate, onOpenFile }) {
  const [hovered, setHovered] = useState(null)

  if (entries.length === 0) {
    return (
      <div style={gridStyles.empty}>
        This directory is empty.
      </div>
    )
  }

  return (
    <div style={gridStyles.grid}>
      {entries.map(entry => (
        <div
          key={entry.path}
          style={{
            ...gridStyles.icon,
            ...(hovered === entry.path ? gridStyles.iconHover : {}),
          }}
          onMouseEnter={() => setHovered(entry.path)}
          onMouseLeave={() => setHovered(null)}
          onClick={() => entry.is_dir ? onNavigate(entry.path) : onOpenFile(entry)}
          title={entry.is_dir ? entry.name : `${entry.name} · ${formatSize(entry.size)}`}
        >
          <span style={gridStyles.emoji}>{fileIcon(entry)}</span>
          <span style={gridStyles.label}>{entry.name}</span>
          {!entry.is_dir && (
            <span style={gridStyles.size}>{formatSize(entry.size)}</span>
          )}
        </div>
      ))}
    </div>
  )
}

const gridStyles = {
  grid: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    padding: '16px',
    alignContent: 'flex-start',
    overflowY: 'auto',
    flex: 1,
  },
  icon: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
    padding: '10px 8px 8px',
    borderRadius: '12px',
    cursor: 'pointer',
    width: '86px',
    transition: 'background 0.12s',
  },
  iconHover: {
    background: 'rgba(255,255,255,0.1)',
  },
  emoji: {
    fontSize: '36px',
    lineHeight: 1,
    filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.5))',
  },
  label: {
    fontSize: '11px',
    color: 'rgba(255,255,255,0.85)',
    textAlign: 'center',
    wordBreak: 'break-all',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    lineHeight: 1.3,
    maxWidth: '80px',
    textShadow: '0 1px 3px rgba(0,0,0,0.7)',
  },
  size: {
    fontSize: '9px',
    color: 'rgba(255,255,255,0.3)',
    fontFamily: 'monospace',
  },
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'rgba(255,255,255,0.3)',
    fontSize: '13px',
  },
}

export default function FileBrowser() {
  const [currentPath, setCurrentPath] = useState('/')
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editFile, setEditFile] = useState(null)   // { path, mimeHint, content }
  const [loadingFile, setLoadingFile] = useState(null)

  const loadDir = useCallback(async (path) => {
    setLoading(true)
    setError(null)
    try {
      const data = await listFiles(path)
      setEntries(data)
      setCurrentPath(path)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDir('/')
  }, [loadDir])

  async function handleOpenFile(entry) {
    setLoadingFile(entry.path)
    try {
      const content = await readFile(entry.path)
      setEditFile({ path: entry.path, mimeHint: entry.mime_hint, content })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoadingFile(null)
    }
  }

  if (editFile) {
    return (
      <FileEditor
        path={editFile.path}
        mimeHint={editFile.mimeHint}
        initialContent={editFile.content}
        onClose={() => setEditFile(null)}
        onSaved={() => {}}
      />
    )
  }

  return (
    <div style={styles.wrap}>
      <Breadcrumb path={currentPath} onNavigate={loadDir} />

      <div style={styles.body}>
        {loading && (
          <div style={styles.overlay}>Loading…</div>
        )}
        {loadingFile && (
          <div style={styles.overlay}>Opening file…</div>
        )}
        {error && !loading && (
          <div style={styles.errorBar}>{error}</div>
        )}
        {!loading && !error && (
          <FileGrid
            entries={entries}
            onNavigate={loadDir}
            onOpenFile={handleOpenFile}
          />
        )}
      </div>

      <div style={styles.statusBar}>
        {!loading && !error && (
          <span>{entries.length} item{entries.length !== 1 ? 's' : ''}</span>
        )}
        <span style={styles.pathPill}>{currentPath}</span>
      </div>
    </div>
  )
}

const styles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'rgba(14,22,36,0.9)',
    borderRadius: '0 0 12px 12px',
    overflow: 'hidden',
  },
  body: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    overflow: 'hidden',
  },
  overlay: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'rgba(255,255,255,0.4)',
    fontSize: '13px',
    background: 'rgba(14,22,36,0.6)',
    backdropFilter: 'blur(4px)',
    zIndex: 5,
  },
  errorBar: {
    padding: '12px 16px',
    background: 'rgba(255,80,80,0.1)',
    color: 'rgba(255,160,160,0.9)',
    fontSize: '12px',
    borderBottom: '1px solid rgba(255,80,80,0.2)',
  },
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 14px',
    borderTop: '1px solid rgba(255,255,255,0.07)',
    color: 'rgba(255,255,255,0.3)',
    fontSize: '11px',
    flexShrink: 0,
  },
  pathPill: {
    fontFamily: 'monospace',
    background: 'rgba(255,255,255,0.05)',
    padding: '2px 8px',
    borderRadius: '6px',
    fontSize: '10px',
  },
}
