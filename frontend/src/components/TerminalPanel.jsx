import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

// Module-level singletons — survive component unmount/remount so the terminal
// session (scrollback, cwd, command history) is preserved when the window closes.
let _term = null
let _fit = null
let _ws = null
let _container = null     // persistent div that xterm renders into
let _onDataDisposable = null
let _opened = false       // whether _term.open() has been called
let _sessionStarted = false

function _sendResize() {
  if (!_ws || _ws.readyState !== WebSocket.OPEN || !_term) return
  _ws.send(JSON.stringify({ type: 'resize', cols: _term.cols, rows: _term.rows }))
}

function _connect(authToken) {
  // Dispose previous onData handler before registering a new one.
  if (_onDataDisposable) {
    _onDataDisposable.dispose()
    _onDataDisposable = null
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(
    `${proto}//${window.location.host}/ws/terminal?token=${encodeURIComponent(authToken || '')}`
  )
  ws.binaryType = 'arraybuffer'
  _ws = ws

  ws.onopen = () => {
    // Show the banner only on the very first connection; on reconnect the
    // backend replays any missed output so the banner would be redundant.
    if (!_sessionStarted) {
      _term.write('\r\n\x1b[1;32m✦ Nimbus Container Terminal\x1b[0m\r\n\r\n')
      _sessionStarted = true
    }
    requestAnimationFrame(() => { _fit?.fit(); _sendResize() })
  }

  ws.onmessage = (e) => {
    if (!_term) return
    if (e.data instanceof ArrayBuffer) {
      _term.write(new Uint8Array(e.data))
    } else if (typeof e.data === 'string') {
      try {
        const msg = JSON.parse(e.data)
        if (msg.error) _term.writeln(`\r\n\x1b[1;31mError: ${msg.error}\x1b[0m`)
      } catch {
        _term.write(e.data)
      }
    }
  }

  ws.onerror = () => {
    _term?.writeln('\r\n\x1b[1;31mConnection error\x1b[0m')
  }

  ws.onclose = (e) => {
    // The shell exited or the connection dropped — show a message and allow
    // the banner to reappear if the user opens a fresh session.
    _sessionStarted = false
    _term?.writeln(`\r\n\x1b[2m[Session closed${e.reason ? ': ' + e.reason : ''}]\x1b[0m`)
  }

  _onDataDisposable = _term.onData((data) => {
    if (_ws?.readyState === WebSocket.OPEN) {
      _ws.send(new TextEncoder().encode(data))
    }
  })
}

export default function TerminalPanel({ authToken }) {
  const wrapperRef = useRef(null)

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    // Create the Terminal and persistent container on first mount.
    if (!_term) {
      _term = new Terminal({
        theme: {
          background: '#0d1117',
          foreground: '#e6edf3',
          cursor: '#58a6ff',
          selectionBackground: 'rgba(88,166,255,0.25)',
          black: '#21262d',
          red: '#ff7b72',
          green: '#3fb950',
          yellow: '#d29922',
          blue: '#58a6ff',
          magenta: '#bc8cff',
          cyan: '#76e3ea',
          white: '#b1bac4',
          brightBlack: '#6e7681',
          brightRed: '#ffa198',
          brightGreen: '#56d364',
          brightYellow: '#e3b341',
          brightBlue: '#79c0ff',
          brightMagenta: '#d2a8ff',
          brightCyan: '#b3f0ff',
          brightWhite: '#f0f6fc',
        },
        fontFamily: '"Cascadia Code", "Fira Code", "SF Mono", ui-monospace, monospace',
        fontSize: 13,
        lineHeight: 1.4,
        cursorBlink: true,
        scrollback: 5000,
        allowProposedApi: true,
      })
      _fit = new FitAddon()
      _term.loadAddon(_fit)
      _term.loadAddon(new WebLinksAddon())
      _container = document.createElement('div')
      _container.style.cssText = 'flex:1; padding:8px; overflow:hidden; min-height:0;'
    }

    // Move the persistent container into this wrapper. appendChild is a
    // no-op if already parented here, and a move if coming from elsewhere.
    wrapper.appendChild(_container)

    // Open xterm into the container the first time it's in the DOM.
    if (!_opened) {
      _term.open(_container)
      _opened = true
      _connect(authToken)
    } else if (!_ws || _ws.readyState === WebSocket.CLOSED || _ws.readyState === WebSocket.CLOSING) {
      // Reconnect if the WS died while the terminal window was closed.
      _connect(authToken)
    }

    // Refit now that the container is visible again.
    requestAnimationFrame(() => { _fit?.fit(); _sendResize() })

    const ro = new ResizeObserver(() => { _fit?.fit(); _sendResize() })
    ro.observe(wrapper)

    return () => {
      ro.disconnect()
      // Orphan the container — keep Terminal and WS alive for next open.
      if (_container?.parentNode) _container.parentNode.removeChild(_container)
    }
  }, [authToken])

  return <div ref={wrapperRef} style={styles.shell} />
}

const styles = {
  shell: {
    width: '100%',
    height: '100%',
    background: '#0d1117',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
}
