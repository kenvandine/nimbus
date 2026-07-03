import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { RotateCcw, Power } from 'lucide-react'
import { restartSystem, powerOffSystem } from '../api.js'
import { qrColors } from '../theme.js'
import Spinner from './ui/Spinner.jsx'
import Badge from './ui/Badge.jsx'
import NimbusMark from './ui/NimbusMark.jsx'

const LONG_PRESS_MS = 1200

function useLongPress(onLongPress) {
  const timerRef = useRef(null)
  const [pressing, setPressing] = useState(false)

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  function start() {
    if (timerRef.current) clearTimeout(timerRef.current)
    setPressing(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setPressing(false)
      onLongPress()
    }, LONG_PRESS_MS)
  }

  function cancel() {
    setPressing(false)
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
  }

  return {
    onMouseDown: start,
    onTouchStart: start,
    onMouseUp: cancel,
    onMouseLeave: cancel,
    onTouchEnd: cancel,
    pressing,
  }
}

export default function KioskReadyScreen({ stats }) {
  const canvasRef = useRef(null)
  const [qrError, setQrError] = useState(false)
  const [powerBusy, setPowerBusy] = useState(null)

  const hostIp = stats?.host_ip
  const nimbuUrl = hostIp ? `http://${hostIp}` : null
  const bootstrapReady = stats?.container_bootstrapped && stats?.bootstrap_state === 'ready'
  const bootstrapError = stats?.bootstrap_error
  const powerAvailable = Boolean(stats?.device_management_available)

  useEffect(() => {
    if (!nimbuUrl || !canvasRef.current) return
    QRCode.toCanvas(canvasRef.current, nimbuUrl, {
      width: 200,
      margin: 2,
      color: qrColors,
    }).catch(() => setQrError(true))
  }, [nimbuUrl, bootstrapReady])

  async function handleRestart() {
    setPowerBusy('restart')
    try { await restartSystem() } catch {}
    finally { setPowerBusy(null) }
  }

  async function handlePowerOff() {
    setPowerBusy('poweroff')
    try { await powerOffSystem() } catch {}
    finally { setPowerBusy(null) }
  }

  const restartPress = useLongPress(handleRestart)
  const powerOffPress = useLongPress(handlePowerOff)

  return (
    <div style={styles.screen}>
      <div style={styles.card}>
        <div style={styles.logoRow}>
          <NimbusMark size={26} />
          <span style={styles.logo}>Nimbus</span>
        </div>

        {!bootstrapReady && !bootstrapError && (
          <div style={styles.setupSection}>
            <Spinner size={32} thickness={3} />
            <div style={styles.setupTitle}>Setting up your device…</div>
            <div style={styles.setupMsg}>{formatState(stats?.bootstrap_state)}</div>
          </div>
        )}

        {bootstrapError && (
          <div style={styles.errorSection}>
            <div style={styles.errorTitle}>Setup error</div>
            <div style={styles.errorMsg}>{bootstrapError}</div>
          </div>
        )}

        {bootstrapReady && (
          <>
            <Badge tone="success">Device ready</Badge>
            <div style={styles.headline}>Access Nimbus from another device</div>
            <div style={styles.subtitle}>
              Open this address on any computer or phone connected to the same Wi-Fi network.
            </div>

            {nimbuUrl ? (
              <>
                <div style={styles.urlBox}>{nimbuUrl}</div>
                <div style={styles.qrWrap}>
                  {qrError
                    ? <div style={styles.qrFallback}>QR unavailable</div>
                    : <canvas ref={canvasRef} style={styles.qrCanvas} />
                  }
                </div>
              </>
            ) : (
              <div style={styles.noIp}>
                Connect this device to a network first, then reload this page.
              </div>
            )}
          </>
        )}

        {powerAvailable && (
          <div style={styles.powerRow}>
            <div style={styles.powerHint}>Hold button to activate</div>
            <div style={styles.powerBtns}>
              <button
                style={{
                  ...styles.powerBtn,
                  ...(restartPress.pressing ? styles.powerBtnActive : {}),
                  ...(powerBusy ? styles.powerBtnDisabled : {}),
                }}
                disabled={Boolean(powerBusy)}
                title="Hold to restart"
                {...restartPress}
              >
                {powerBusy === 'restart' ? <Spinner size={18} /> : <RotateCcw size={20} />}
                <span style={styles.powerBtnLabel}>Restart</span>
              </button>
              <button
                style={{
                  ...styles.powerBtn,
                  ...styles.powerBtnOff,
                  ...(powerOffPress.pressing ? styles.powerBtnActive : {}),
                  ...(powerBusy ? styles.powerBtnDisabled : {}),
                }}
                disabled={Boolean(powerBusy)}
                title="Hold to power off"
                {...powerOffPress}
              >
                {powerBusy === 'poweroff' ? <Spinner size={18} color="var(--color-danger)" /> : <Power size={20} />}
                <span style={styles.powerBtnLabel}>Power Off</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function formatState(state) {
  return {
    idle: 'Preparing…',
    'waiting-for-network': 'Waiting for network…',
    'ensuring-profile': 'Configuring LXD profile…',
    'importing-image': 'Importing container image…',
    'ensuring-container': 'Starting container…',
    'installing-runtime': 'Installing runtime packages…',
    'pushing-agent': 'Copying Nimbus services…',
    'installing-agent-python': 'Installing dependencies…',
    'starting-agent': 'Starting Nimbus services…',
    ready: 'Finalizing…',
  }[state] || 'Preparing…'
}

const styles = {
  screen: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(160deg, var(--nimbus-charcoal-950) 0%, var(--nimbus-charcoal-900) 55%, var(--nimbus-charcoal-800) 100%)',
    fontFamily: 'var(--font-sans)',
  },
  card: {
    width: 380,
    padding: '40px 36px',
    background: 'var(--color-surface-2)',
    border: '1px solid var(--color-border-subtle)',
    borderRadius: 'var(--radius-xl)',
    backdropFilter: 'blur(var(--blur-lg))',
    boxShadow: 'var(--shadow-xl)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 20,
    textAlign: 'center',
  },
  logoRow: { display: 'flex', alignItems: 'center', gap: 10 },
  logo: {
    fontSize: 18,
    fontWeight: 'var(--font-weight-bold)',
    color: 'var(--text-primary)',
    letterSpacing: '-0.01em',
  },
  setupSection: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    padding: '8px 0',
  },
  setupTitle: {
    fontSize: 17,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  setupMsg: {
    fontSize: 13,
    color: 'var(--text-tertiary)',
  },
  errorSection: {
    padding: '12px 16px',
    background: 'var(--color-danger-soft-bg)',
    border: '1px solid var(--color-danger-soft-border)',
    borderRadius: 'var(--radius-md)',
    width: '100%',
  },
  errorTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--color-danger-soft-text)',
    marginBottom: 4,
  },
  errorMsg: {
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
  headline: {
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--text-primary)',
    lineHeight: 1.3,
  },
  subtitle: {
    fontSize: 14,
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
  },
  urlBox: {
    fontFamily: 'var(--font-mono)',
    fontSize: 19,
    fontWeight: 700,
    color: 'var(--color-accent-soft-text)',
    background: 'var(--color-accent-soft-bg)',
    border: '1px solid var(--color-accent-soft-border)',
    borderRadius: 'var(--radius-md)',
    padding: '12px 20px',
    letterSpacing: '0.01em',
    width: '100%',
    boxSizing: 'border-box',
  },
  qrWrap: {
    background: qrColors.light,
    borderRadius: 'var(--radius-lg)',
    padding: 12,
    display: 'inline-flex',
  },
  qrCanvas: {
    display: 'block',
  },
  qrFallback: {
    width: 200,
    height: 200,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#666',
    fontSize: 13,
  },
  noIp: {
    fontSize: 13,
    color: 'var(--text-tertiary)',
    fontStyle: 'italic',
  },
  powerRow: {
    width: '100%',
    borderTop: '1px solid var(--color-border-subtle)',
    paddingTop: 16,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 10,
  },
  powerHint: {
    fontSize: 10,
    color: 'var(--text-disabled)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  powerBtns: {
    display: 'flex',
    gap: 12,
  },
  powerBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    padding: '10px 20px',
    minHeight: 56,
    background: 'var(--color-surface-3)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: 'var(--radius-md)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    transition: 'background var(--duration-fast), transform var(--duration-fast)',
    userSelect: 'none',
  },
  powerBtnOff: {
    color: 'var(--color-danger)',
  },
  powerBtnActive: {
    background: 'var(--color-accent-soft-bg)',
    border: '1px solid var(--color-accent-soft-border)',
    transform: 'scale(0.95)',
  },
  powerBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  powerBtnLabel: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
  },
}
