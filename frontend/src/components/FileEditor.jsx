import { useCallback, useEffect, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { yaml } from '@codemirror/lang-yaml'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { ArrowLeft } from 'lucide-react'
import { writeFile } from '../api.js'
import Button from './ui/Button.jsx'

function extensionForMime(mime) {
  switch (mime) {
    case 'javascript':
    case 'typescript': return [javascript({ typescript: mime === 'typescript', jsx: true })]
    case 'python':     return [python()]
    case 'markdown':   return [markdown()]
    case 'html':       return [html()]
    case 'css':        return [css()]
    case 'json':       return [json()]
    case 'yaml':       return [yaml()]
    case 'rust':       return [rust()]
    case 'cpp':        return [cpp()]
    case 'java':       return [java()]
    case 'sql':        return [sql()]
    case 'xml':        return [xml()]
    default:           return []
  }
}

export default function FileEditor({ path, mimeHint, initialContent, onClose, onSaved }) {
  const [value, setValue] = useState(initialContent ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setValue(initialContent ?? '')
    setDirty(false)
    setSaveError(null)
  }, [path, initialContent])

  const onChange = useCallback((val) => {
    setValue(val)
    setDirty(true)
  }, [])

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      await writeFile(path, value)
      setDirty(false)
      onSaved?.()
    } catch (e) {
      setSaveError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const filename = path.split('/').filter(Boolean).pop() || path

  return (
    <div style={styles.wrap}>
      <div style={styles.toolbar}>
        <Button variant="secondary" size="sm" onClick={onClose} title="Back to file browser">
          <ArrowLeft size={14} /> Back
        </Button>
        <span style={styles.filename}>{filename}</span>
        <span style={{ ...styles.mimePill, ...(mimeHint ? {} : styles.mimePillMuted) }}>
          {mimeHint || 'text'}
        </span>
        {dirty && <span style={styles.dirtyDot} title="Unsaved changes" />}
        <div style={{ flex: 1 }} />
        {saveError && <span style={styles.saveError}>{saveError}</span>}
        <Button variant="soft" size="sm" onClick={handleSave} disabled={!dirty || saving} loading={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <div style={styles.editorWrap}>
        <CodeMirror
          value={value}
          height="100%"
          theme={oneDark}
          extensions={extensionForMime(mimeHint)}
          onChange={onChange}
          style={{ height: '100%', fontSize: '13px' }}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            autocompletion: true,
            highlightActiveLine: true,
            bracketMatching: true,
            indentOnInput: true,
          }}
        />
      </div>
    </div>
  )
}

const styles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: '#282c34',
    overflow: 'hidden',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px 12px',
    background: 'rgba(0,0,0,0.3)',
    borderBottom: '1px solid var(--color-border-subtle)',
    flexShrink: 0,
    flexWrap: 'wrap',
    minHeight: '44px',
  },
  filename: {
    color: 'var(--text-primary)',
    fontSize: '13px',
    fontWeight: 600,
    fontFamily: 'var(--font-mono)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '260px',
  },
  mimePill: {
    background: 'var(--color-accent-soft-bg)',
    color: 'var(--color-accent-soft-text)',
    border: '1px solid var(--color-accent-soft-border)',
    borderRadius: 'var(--radius-sm)',
    padding: '2px 8px',
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--font-sans)',
  },
  mimePillMuted: {
    background: 'var(--color-surface-2)',
    color: 'var(--text-tertiary)',
    border: '1px solid var(--color-border-subtle)',
  },
  dirtyDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: 'var(--color-warning)',
    flexShrink: 0,
  },
  saveError: {
    color: 'var(--color-danger-soft-text)',
    fontFamily: 'var(--font-sans)',
    fontSize: '11px',
    maxWidth: '200px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  editorWrap: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
}
