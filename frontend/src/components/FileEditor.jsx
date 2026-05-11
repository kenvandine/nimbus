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
import { writeFile } from '../api.js'

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
        <button style={styles.backBtn} onClick={onClose} title="Back to file browser">
          ← Back
        </button>
        <span style={styles.filename}>{filename}</span>
        <span style={{ ...styles.mimePill, ...(mimeHint ? {} : styles.mimePillMuted) }}>
          {mimeHint || 'text'}
        </span>
        {dirty && <span style={styles.dirtyDot} title="Unsaved changes" />}
        <div style={{ flex: 1 }} />
        {saveError && <span style={styles.saveError}>{saveError}</span>}
        <button
          style={{ ...styles.saveBtn, ...((!dirty || saving) ? styles.saveBtnDisabled : {}) }}
          onClick={handleSave}
          disabled={!dirty || saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
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
    borderRadius: '0 0 12px 12px',
    overflow: 'hidden',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px 12px',
    background: 'rgba(0,0,0,0.3)',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    flexShrink: 0,
    flexWrap: 'wrap',
    minHeight: '44px',
  },
  backBtn: {
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'rgba(255,255,255,0.75)',
    borderRadius: '7px',
    padding: '5px 10px',
    fontSize: '12px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  filename: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: '13px',
    fontWeight: 600,
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '260px',
  },
  mimePill: {
    background: 'rgba(79,195,247,0.14)',
    color: 'rgba(129,212,250,0.85)',
    border: '1px solid rgba(79,195,247,0.22)',
    borderRadius: '6px',
    padding: '2px 8px',
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  },
  mimePillMuted: {
    background: 'rgba(255,255,255,0.05)',
    color: 'rgba(255,255,255,0.3)',
    border: '1px solid rgba(255,255,255,0.08)',
  },
  dirtyDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: '#ff9800',
    flexShrink: 0,
  },
  saveError: {
    color: 'rgba(255,138,128,0.9)',
    fontSize: '11px',
    maxWidth: '200px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  saveBtn: {
    background: 'rgba(79,195,247,0.18)',
    color: 'rgba(79,195,247,0.98)',
    border: '1px solid rgba(79,195,247,0.3)',
    borderRadius: '7px',
    padding: '5px 14px',
    fontSize: '12px',
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  saveBtnDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  editorWrap: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },
}
