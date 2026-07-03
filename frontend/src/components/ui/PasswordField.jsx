import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

// Consolidates the type={showPw?'text':'password'} + eye-toggle pattern
// duplicated in Oobe.jsx (x3), Login.jsx, Settings.jsx's WifiPanel.
export default function PasswordField({ value, onChange, placeholder, id, style, inputStyle, ...rest }) {
  const [visible, setVisible] = useState(false)
  return (
    <div style={{ position: 'relative', ...style }}>
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        style={{
          width: '100%',
          minHeight: 44,
          background: 'var(--color-surface-2)',
          border: '1px solid var(--color-border-strong)',
          borderRadius: 'var(--radius-sm)',
          padding: '10px 44px 10px 14px',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--font-size-md)',
          outline: 'none',
          boxSizing: 'border-box',
          ...inputStyle,
        }}
        {...rest}
      />
      <button
        type="button"
        onClick={() => setVisible(v => !v)}
        tabIndex={-1}
        aria-label={visible ? 'Hide password' : 'Show password'}
        style={{
          position: 'absolute',
          right: 10,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 32,
          height: 32,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text-tertiary)',
          padding: 0,
        }}
      >
        {visible ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  )
}
