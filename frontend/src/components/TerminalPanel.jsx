import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

export default function TerminalPanel({ authToken }) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const wsRef = useRef(null)
  const fitRef = useRef(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
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
      scrollback: 2000,
      allowProposedApi: true,
    })

    const fit = new FitAddon()
    const links = new WebLinksAddon()
    term.loadAddon(fit)
    term.loadAddon(links)
    termRef.current = term
    fitRef.current = fit

    term.open(containerRef.current)
    fit.fit()

    // Build WebSocket URL
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const ws = new WebSocket(`${proto}//${host}/ws/terminal?token=${encodeURIComponent(authToken || '')}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      term.write('\r\n\x1b[1;32m✦ Nimbus Container Terminal\x1b[0m\r\n\r\n')
      // Send initial size
      sendResize(fit.proposeDimensions?.() || { cols: term.cols, rows: term.rows })
    }

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data))
      } else if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data)
          if (msg.error) term.writeln(`\r\n\x1b[1;31mError: ${msg.error}\x1b[0m`)
        } catch {
          term.write(e.data)
        }
      }
    }

    ws.onerror = () => {
      term.writeln('\r\n\x1b[1;31mConnection error\x1b[0m')
    }

    ws.onclose = (e) => {
      term.writeln(`\r\n\x1b[2m[Session closed${e.reason ? ': ' + e.reason : ''}]\x1b[0m`)
    }

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data))
      }
    })

    function sendResize(dims) {
      if (!dims) return
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
      }
    }

    const ro = new ResizeObserver(() => {
      fit.fit()
      sendResize({ cols: term.cols, rows: term.rows })
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      ws.close()
      term.dispose()
    }
  }, [authToken])

  return (
    <div style={styles.shell}>
      <div ref={containerRef} style={styles.terminal} />
    </div>
  )
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
  terminal: {
    flex: 1,
    padding: '8px',
    overflow: 'hidden',
  },
}
