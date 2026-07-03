import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { xtermTheme } from '../theme.js'

const TERMINAL_FONT_FAMILY = '"Ubuntu Mono", ui-monospace, "SF Mono", "Cascadia Code", "Fira Code", monospace'

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

async function _connect() {
  // Dispose previous onData handler before registering a new one.
  if (_onDataDisposable) {
    _onDataDisposable.dispose()
    _onDataDisposable = null
  }

  // Close any existing WebSocket before opening a new one.
  if (_ws && _ws.readyState !== WebSocket.CLOSED && _ws.readyState !== WebSocket.CLOSING) {
    _ws.close()
  }

  // Fetch a short-lived WS token rather than reusing the HttpOnly session cookie.
  let wsToken = ''
  try {
    const res = await fetch('/api/auth/ws-token', { credentials: 'same-origin' })
    if (res.ok) {
      const data = await res.json()
      wsToken = data.ws_token || ''
    }
  } catch {
    // Continue with empty token; server rejects if auth is required.
  }

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(
    `${proto}//${window.location.host}/ws/terminal?token=${encodeURIComponent(wsToken)}`
  )
  ws.binaryType = 'arraybuffer'
  _ws = ws

  ws.onopen = () => {
    // Show the banner only on the very first connection; on reconnect the
    // backend replays any missed output so the banner would be redundant.
    if (!_sessionStarted) {
      _term.write('\r\n\x1b[1;32mNimbus Container Terminal\x1b[0m \x1b[2m(nimbus user — sudo available)\x1b[0m\r\n\r\n')
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

// Creates the Terminal + FitAddon + persistent container on first use. Waits
// for the Ubuntu Mono webfont to actually be loaded first — xterm measures
// glyph cell dimensions from whatever font is active at construction time,
// and self-hosted webfonts aren't guaranteed loaded yet on first paint. If
// this ran against the fallback font, cell metrics would be wrong and the
// grid would misalign/clip once Ubuntu Mono swaps in.
async function _ensureTerminal() {
  if (_term) return
  try {
    await document.fonts.load(`13px "Ubuntu Mono"`)
    await document.fonts.ready
  } catch {}

  _term = new Terminal({
    theme: xtermTheme,
    fontFamily: TERMINAL_FONT_FAMILY,
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

export default function TerminalPanel() {
  const wrapperRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    const wrapper = wrapperRef.current
    if (!wrapper) return

    _ensureTerminal().then(() => {
      if (cancelled || !wrapper) return

      // Move the persistent container into this wrapper. appendChild is a
      // no-op if already parented here, and a move if coming from elsewhere.
      wrapper.appendChild(_container)

      // Open xterm into the container the first time it's in the DOM.
      if (!_opened) {
        _term.open(_container)
        _opened = true
        _connect()
      } else if (!_ws || _ws.readyState === WebSocket.CLOSED || _ws.readyState === WebSocket.CLOSING) {
        // Reconnect if the WS died while the terminal window was closed.
        _connect()
      }

      // Refit now that the container is visible again.
      requestAnimationFrame(() => { _fit?.fit(); _sendResize() })
    })

    const ro = new ResizeObserver(() => { _fit?.fit(); _sendResize() })
    ro.observe(wrapper)

    return () => {
      cancelled = true
      ro.disconnect()
      // Orphan the container — keep Terminal and WS alive for next open.
      if (_container?.parentNode) _container.parentNode.removeChild(_container)
    }
  }, [])

  return <div ref={wrapperRef} style={styles.shell} />
}

const styles = {
  shell: {
    width: '100%',
    height: '100%',
    background: 'var(--nimbus-charcoal-950)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
}
