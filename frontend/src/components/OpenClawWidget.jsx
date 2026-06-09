import { useEffect, useState } from 'react'
import { getOpenClawStatus } from '../api.js'

const POLL_MS = 5000

const STATUS_COLOR = {
  active: '#4caf50',
  idle: 'rgba(255,255,255,0.35)',
  done: 'rgba(255,255,255,0.2)',
  unknown: 'rgba(255,255,255,0.2)',
}

const STATUS_LABEL = {
  active: 'active',
  idle: 'idle',
  done: 'done',
  unknown: '',
}

const PULL_ACTIVE = new Set(['checking', 'pulling', 'loading'])

export default function OpenClawWidget() {
  const [status, setStatus] = useState(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    let alive = true
    async function poll() {
      try {
        const s = await getOpenClawStatus()
        if (alive) setStatus(s)
      } catch {}
    }
    poll()
    const id = setInterval(poll, POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (!status) return null

  const lemonade = status.lemonade || { status: 'idle' }
  const pullActive = PULL_ACTIVE.has(lemonade.status)
  const pullFailed = lemonade.status === 'failed'

  // Hide widget only if openclaw has never been reachable AND there's no
  // pull activity to surface. During install we want to show the progress
  // bar even before openclaw's gateway answers.
  if (!status.reachable && !status.last_ok && !pullActive && !pullFailed) return null

  const agents = status.agents || []
  const sessions = status.sessions || []
  const activeSessions = sessions.filter(s => s.status === 'active')

  const headerDotColor = pullActive
    ? '#ffb74d'
    : pullFailed
      ? '#ef5350'
      : status.reachable ? '#4caf50' : '#ef5350'

  return (
    <div style={styles.widget}>
      <button style={styles.header} onClick={() => setCollapsed(c => !c)}>
        <span style={{ ...styles.dot, background: headerDotColor }} />
        <span style={styles.title}>OpenClaw</span>
        {pullActive && (
          <span style={styles.pullBadge}>{Math.round(lemonade.percent || 0)}%</span>
        )}
        {!pullActive && activeSessions.length > 0 && (
          <span style={styles.activeBadge}>{activeSessions.length} active</span>
        )}
        <span style={styles.chevron}>{collapsed ? '▲' : '▼'}</span>
      </button>

      {!collapsed && (
        <div style={styles.body}>
          {pullActive && (
            <PullProgress lemonade={lemonade} />
          )}

          {pullFailed && (
            <div style={styles.errorMsg}>
              Model download failed{lemonade.error ? `: ${lemonade.error}` : ''}
            </div>
          )}

          {!pullActive && !status.reachable && (
            <div style={styles.offlineMsg}>
              {status.auth_required ? 'Auth required' : 'Connecting…'}
            </div>
          )}

          {!pullActive && agents.length === 0 && status.reachable && (
            <div style={styles.emptyMsg}>No agents found</div>
          )}

          {!pullActive && agents.map(agent => {
            const agentSessions = sessions.filter(s => s.agent_id === agent.id)
            return (
              <div key={agent.id} style={styles.agentBlock}>
                <div style={styles.agentRow}>
                  <span style={styles.agentEmoji}>{agent.emoji}</span>
                  <span style={styles.agentName}>{agent.name}</span>
                  {agent.default && <span style={styles.defaultBadge}>default</span>}
                </div>
                {agentSessions.map(sess => (
                  <div key={sess.id} style={styles.sessionRow}>
                    <span style={{ ...styles.sessionDot, background: STATUS_COLOR[sess.status] || STATUS_COLOR.unknown }} />
                    <div style={styles.sessionInfo}>
                      {sess.summary ? (
                        <span style={styles.sessionSummary}>{sess.summary}</span>
                      ) : (
                        <span style={styles.sessionStatus}>{STATUS_LABEL[sess.status] || sess.status}</span>
                      )}
                    </div>
                  </div>
                ))}
                {agentSessions.length === 0 && (
                  <div style={styles.noSessions}>no active sessions</div>
                )}
              </div>
            )
          })}

          {/* Sessions whose agent isn't in the agents list */}
          {!pullActive && sessions.filter(s => !agents.find(a => a.id === s.agent_id)).map(sess => (
            <div key={sess.id} style={styles.sessionRow}>
              <span style={{ ...styles.sessionDot, background: STATUS_COLOR[sess.status] || STATUS_COLOR.unknown }} />
              <div style={styles.sessionInfo}>
                {sess.summary ? (
                  <span style={styles.sessionSummary}>{sess.summary}</span>
                ) : (
                  <span style={styles.sessionStatus}>{STATUS_LABEL[sess.status] || sess.status}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PullProgress({ lemonade }) {
  const pct = Math.max(0, Math.min(100, Number(lemonade.percent) || 0))
  const label =
    lemonade.status === 'checking' ? 'Preparing model…'
    : lemonade.status === 'loading' ? 'Loading model into memory…'
    : 'Downloading model'
  const fileMeta =
    lemonade.total_files > 0
      ? `file ${lemonade.file_index || 1}/${lemonade.total_files}`
      : ''
  return (
    <div style={styles.pullBlock}>
      <div style={styles.pullLabel}>{label}</div>
      {lemonade.model && <div style={styles.pullModel}>{lemonade.model}</div>}
      <div style={styles.pullBarTrack}>
        <div style={{ ...styles.pullBarFill, width: `${pct}%` }} />
      </div>
      <div style={styles.pullMeta}>
        <span>{Math.round(pct)}%</span>
        {fileMeta && <span>{fileMeta}</span>}
      </div>
      <div style={styles.pullHint}>
        OpenClaw will be unable to respond until the model is ready.
      </div>
    </div>
  )
}

const styles = {
  widget: {
    width: '220px',
    background: 'rgba(8,16,28,0.82)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '14px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    backdropFilter: 'blur(18px)',
    overflow: 'hidden',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    width: '100%',
    background: 'none',
    border: 'none',
    padding: '10px 12px',
    cursor: 'pointer',
    color: 'white',
  },
  dot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  title: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'rgba(255,255,255,0.85)',
    flex: 1,
    textAlign: 'left',
  },
  activeBadge: {
    fontSize: '10px',
    fontWeight: 700,
    padding: '1px 6px',
    borderRadius: '999px',
    background: 'rgba(76,175,80,0.25)',
    color: '#81c784',
    letterSpacing: '0.02em',
  },
  pullBadge: {
    fontSize: '10px',
    fontWeight: 700,
    padding: '1px 6px',
    borderRadius: '999px',
    background: 'rgba(255,183,77,0.22)',
    color: '#ffcc80',
    letterSpacing: '0.02em',
    fontVariantNumeric: 'tabular-nums',
  },
  pullBlock: {
    padding: '6px 2px 2px',
  },
  pullLabel: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'rgba(255,255,255,0.88)',
    marginBottom: '2px',
  },
  pullModel: {
    fontSize: '10px',
    color: 'rgba(255,255,255,0.45)',
    fontFamily: 'ui-monospace, "SF Mono", monospace',
    marginBottom: '8px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  pullBarTrack: {
    width: '100%',
    height: '6px',
    background: 'rgba(255,255,255,0.08)',
    borderRadius: '999px',
    overflow: 'hidden',
  },
  pullBarFill: {
    height: '100%',
    background: 'linear-gradient(90deg, #ff9800, #ffcc80)',
    borderRadius: '999px',
    transition: 'width 0.4s ease-out',
  },
  pullMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '10px',
    color: 'rgba(255,255,255,0.55)',
    marginTop: '4px',
    fontVariantNumeric: 'tabular-nums',
  },
  pullHint: {
    fontSize: '10px',
    color: 'rgba(255,255,255,0.35)',
    marginTop: '8px',
    lineHeight: 1.35,
    fontStyle: 'italic',
  },
  errorMsg: {
    fontSize: '11px',
    color: '#ef9a9a',
    padding: '6px 2px 8px',
    lineHeight: 1.35,
  },
  chevron: {
    fontSize: '9px',
    color: 'rgba(255,255,255,0.35)',
  },
  body: {
    padding: '0 10px 10px',
    maxHeight: '320px',
    overflowY: 'auto',
  },
  offlineMsg: {
    fontSize: '11px',
    color: 'rgba(255,255,255,0.4)',
    padding: '4px 2px 8px',
    fontStyle: 'italic',
  },
  emptyMsg: {
    fontSize: '11px',
    color: 'rgba(255,255,255,0.3)',
    padding: '4px 2px 8px',
    fontStyle: 'italic',
  },
  agentBlock: {
    marginBottom: '8px',
  },
  agentRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '3px',
  },
  agentEmoji: {
    fontSize: '14px',
    lineHeight: 1,
  },
  agentName: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'rgba(255,255,255,0.88)',
    flex: 1,
  },
  defaultBadge: {
    fontSize: '9px',
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: '999px',
    background: 'rgba(79,195,247,0.18)',
    color: '#81d4fa',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },
  sessionRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '6px',
    paddingLeft: '8px',
    marginBottom: '2px',
  },
  sessionDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    flexShrink: 0,
    marginTop: '4px',
  },
  sessionInfo: {
    flex: 1,
    minWidth: 0,
  },
  sessionSummary: {
    fontSize: '11px',
    color: 'rgba(255,255,255,0.72)',
    lineHeight: 1.35,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  sessionStatus: {
    fontSize: '10px',
    color: 'rgba(255,255,255,0.35)',
    fontStyle: 'italic',
  },
  noSessions: {
    fontSize: '10px',
    color: 'rgba(255,255,255,0.22)',
    paddingLeft: '8px',
    fontStyle: 'italic',
  },
}
