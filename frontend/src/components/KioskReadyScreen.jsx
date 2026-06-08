import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

export default function KioskReadyScreen({ stats }) {
  const canvasRef = useRef(null)
  const [qrError, setQrError] = useState(false)

  const hostIp = stats?.host_ip
  const nimbuUrl = hostIp ? `http://${hostIp}` : null
  const bootstrapReady = stats?.container_bootstrapped && stats?.bootstrap_state === 'ready'
  const bootstrapError = stats?.bootstrap_error

  useEffect(() => {
    if (!nimbuUrl || !canvasRef.current) return
    QRCode.toCanvas(canvasRef.current, nimbuUrl, {
      width: 200,
      margin: 2,
      color: { dark: '#0d1117', light: '#f0f6ff' },
    }).catch(() => setQrError(true))
  }, [nimbuUrl])

  return (
    <div style={styles.screen}>
      <div style={styles.card}>
        <div style={styles.logo}>✦ Nimbus</div>

        {!bootstrapReady && !bootstrapError && (
          <div style={styles.setupSection}>
            <div style={styles.spinner} />
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
            <div style={styles.readyBadge}>Device ready</div>
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
    background: 'linear-gradient(145deg, hsl(215,75%,8%) 0%, hsl(220,60%,14%) 60%, hsl(200,55%,22%) 100%)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  card: {
    width: 380,
    padding: '40px 36px',
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 24,
    backdropFilter: 'blur(20px)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 20,
    textAlign: 'center',
  },
  logo: {
    fontSize: 20,
    fontWeight: 700,
    color: '#81d4fa',
    letterSpacing: '0.04em',
  },
  setupSection: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    padding: '8px 0',
  },
  spinner: {
    width: 32,
    height: 32,
    border: '3px solid rgba(79,195,247,0.2)',
    borderTop: '3px solid #4fc3f7',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  setupTitle: {
    fontSize: 17,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.85)',
  },
  setupMsg: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.45)',
  },
  errorSection: {
    padding: '12px 16px',
    background: 'rgba(229,57,53,0.12)',
    border: '1px solid rgba(229,57,53,0.3)',
    borderRadius: 12,
    width: '100%',
  },
  errorTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: '#ef9a9a',
    marginBottom: 4,
  },
  errorMsg: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.6)',
  },
  readyBadge: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    color: '#4caf50',
    background: 'rgba(76,175,80,0.12)',
    border: '1px solid rgba(76,175,80,0.3)',
    borderRadius: 20,
    padding: '4px 14px',
  },
  headline: {
    fontSize: 20,
    fontWeight: 700,
    color: 'rgba(255,255,255,0.92)',
    lineHeight: 1.3,
  },
  subtitle: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.5)',
    lineHeight: 1.6,
  },
  urlBox: {
    fontSize: 20,
    fontWeight: 700,
    color: '#81d4fa',
    background: 'rgba(79,195,247,0.1)',
    border: '1px solid rgba(79,195,247,0.3)',
    borderRadius: 12,
    padding: '12px 20px',
    letterSpacing: '0.01em',
    width: '100%',
  },
  qrWrap: {
    background: '#f0f6ff',
    borderRadius: 16,
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
    color: 'rgba(255,255,255,0.45)',
    fontStyle: 'italic',
  },
}
