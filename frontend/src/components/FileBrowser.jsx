import { useCallback, useEffect, useState } from 'react'
import { Folder, FileText, FileCode2, Globe, Palette, Braces, Settings2, Terminal as TerminalIcon, Database, File as FileIcon } from 'lucide-react'
import { listFiles, readFile } from '../api.js'
import FileEditor from './FileEditor.jsx'

function FileTypeIcon({ entry, size = 32 }) {
  if (entry.is_dir) return <Folder size={size} color="var(--color-info)" fill="var(--color-info-soft-bg)" />
  const props = { size, color: 'var(--text-secondary)' }
  switch (entry.mime_hint) {
    case 'markdown':   return <FileText {...props} />
    case 'python':
    case 'javascript':
    case 'typescript':
    case 'rust':       return <FileCode2 {...props} />
    case 'html':       return <Globe {...props} />
    case 'css':        return <Palette {...props} />
    case 'json':       return <Braces {...props} />
    case 'yaml':       return <Settings2 {...props} />
    case 'shell':      return <TerminalIcon {...props} />
    case 'sql':        return <Database {...props} />
    default:           return <FileIcon {...props} />
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
    borderBottom: '1px solid var(--color-border-subtle)',
    flexShrink: 0,
  },
  crumbGroup: { display: 'flex', alignItems: 'center' },
  sep: { color: 'var(--text-disabled)', padding: '0 3px', fontSize: '12px' },
  crumb: {
    background: 'none',
    border: 'none',
    color: 'var(--color-accent-soft-text)',
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: 'var(--radius-sm)',
  },
  crumbActive: {
    color: 'var(--text-secondary)',
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
          <FileTypeIcon entry={entry} />
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
    gap: '6px',
    padding: '10px 8px 8px',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    width: '86px',
    transition: 'background var(--duration-fast)',
  },
  iconHover: {
    background: 'var(--color-surface-2)',
  },
  label: {
    fontFamily: 'var(--font-sans)',
    fontSize: '11px',
    color: 'var(--text-primary)',
    textAlign: 'center',
    wordBreak: 'break-all',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    lineHeight: 1.3,
    maxWidth: '80px',
  },
  size: {
    fontSize: '9px',
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-mono)',
  },
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-tertiary)',
    fontFamily: 'var(--font-sans)',
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
    background: 'var(--color-bg-canvas)',
    overflow: 'hidden',
    fontFamily: 'var(--font-sans)',
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
    color: 'var(--text-tertiary)',
    fontSize: '13px',
    background: 'rgba(0,0,0,0.4)',
    backdropFilter: 'blur(4px)',
    zIndex: 5,
  },
  errorBar: {
    padding: '12px 16px',
    background: 'var(--color-danger-soft-bg)',
    color: 'var(--color-danger-soft-text)',
    fontSize: '12px',
    borderBottom: '1px solid var(--color-danger-soft-border)',
  },
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 14px',
    borderTop: '1px solid var(--color-border-subtle)',
    color: 'var(--text-tertiary)',
    fontSize: '11px',
    flexShrink: 0,
  },
  pathPill: {
    fontFamily: 'var(--font-mono)',
    background: 'var(--color-surface-2)',
    padding: '2px 8px',
    borderRadius: 'var(--radius-sm)',
    fontSize: '10px',
  },
}
