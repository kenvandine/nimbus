from __future__ import annotations

"""Background service that maintains a WebSocket connection to the local OpenClaw
gateway and surfaces agent / session state for the Nimbus UI.

Protocol overview (from OpenClaw gateway docs):
  Server → client  { type:"event",  event:"connect.challenge", payload:{nonce,ts} }
  Client → server  { type:"req",    id:"1", method:"connect",  params:{...} }
  Server → client  { type:"res",    id:"1", ok:true,  payload:{snapshot,...} }
  Client → server  { type:"req",    id:"2", method:"agents.list", params:{} }
  Server → client  { type:"res",    id:"2", ok:true,  payload:{agents:[...]} }
  Client → server  { type:"req",    id:"3", method:"sessions.describe", params:{} }
  Server → client  { type:"res",    id:"3", ok:true,  payload:{sessions:[...]} }

After handshake the connection is kept alive to receive pushed events.
"""

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

OPENCLAW_PORT = 18790
_RECONNECT_DELAY = 10.0   # seconds between reconnection attempts
_REFRESH_AGENTS = 30.0    # re-fetch agents.list this often (seconds)
_RPC_TIMEOUT = 8.0        # max seconds to wait for an RPC response


@dataclass
class AgentInfo:
    id: str
    name: str
    emoji: str = "🤖"
    default: bool = False


@dataclass
class SessionInfo:
    id: str
    agent_id: str
    status: str = "unknown"   # "active" | "idle" | "done" | "unknown"
    summary: str = ""         # short description of what the agent is doing


@dataclass
class OpenClawStatus:
    reachable: bool = False
    auth_required: bool = False
    agents: list[AgentInfo] = field(default_factory=list)
    sessions: list[SessionInfo] = field(default_factory=list)
    error: str | None = None
    last_ok: float = 0.0      # monotonic timestamp of last successful poll


_status = OpenClawStatus()
_bg_task: asyncio.Task | None = None


def get_status() -> OpenClawStatus:
    return _status


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

async def _rpc(ws, method: str, params: dict, req_id: str) -> dict[str, Any] | None:
    """Send an RPC request and wait for the matching response frame."""
    await ws.send(json.dumps({"type": "req", "id": req_id, "method": method, "params": params}))
    deadline = asyncio.get_event_loop().time() + _RPC_TIMEOUT
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            return None
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except asyncio.TimeoutError:
            return None
        msg = json.loads(raw)
        if msg.get("type") == "res" and msg.get("id") == req_id:
            return msg
        # Discard unrelated frames (events, other responses).


def _parse_agents(payload: dict) -> list[AgentInfo]:
    agents = []
    for a in payload.get("agents", []):
        identity = a.get("identity") or {}
        agents.append(AgentInfo(
            id=str(a.get("id", "")),
            name=str(identity.get("name") or a.get("name") or "Agent"),
            emoji=str(identity.get("emoji") or "🤖"),
            default=bool(a.get("default")),
        ))
    return agents


def _parse_sessions(payload: dict) -> list[SessionInfo]:
    sessions = []
    for s in payload.get("sessions", []):
        state = str(s.get("state") or s.get("status") or "unknown").lower()
        # Map OpenClaw session states to simplified labels.
        if state in {"running", "active", "thinking", "executing"}:
            status = "active"
        elif state in {"done", "completed", "finished", "cancelled"}:
            status = "done"
        else:
            status = "idle"
        # Try to find a human-readable summary.
        summary = (
            str(s.get("title") or s.get("summary") or s.get("lastMessage") or "")[:120]
        )
        sessions.append(SessionInfo(
            id=str(s.get("id", "")),
            agent_id=str(s.get("agentId") or s.get("agent_id") or ""),
            status=status,
            summary=summary,
        ))
    return sessions


async def _handshake(ws, token: str | None) -> bool:
    """Complete the connect.challenge / connect handshake.  Returns True on success."""
    # Wait for connect.challenge event.
    try:
        raw = await asyncio.wait_for(ws.recv(), timeout=_RPC_TIMEOUT)
    except asyncio.TimeoutError:
        return False
    msg = json.loads(raw)
    if msg.get("type") != "event" or msg.get("event") != "connect.challenge":
        logger.debug("OpenClaw: unexpected first frame: %s", msg.get("event"))
        return False

    connect_resp = await _rpc(ws, "connect", {
        "minProtocol": 1,
        "client": {"name": "nimbus", "version": "0.1.0"},
        "role": "observer",
        "scopes": [],
        "token": token,
    }, req_id="oc-connect")

    if connect_resp is None:
        return False
    if not connect_resp.get("ok"):
        err = connect_resp.get("error") or {}
        logger.debug("OpenClaw connect rejected: %s", err.get("message", "unknown"))
        return False
    return True


async def _poll_once(port: int, token: str | None) -> tuple[bool, bool, list[AgentInfo], list[SessionInfo], str | None]:
    """Connect, handshake, fetch state, disconnect.
    Returns (reachable, auth_required, agents, sessions, error)."""
    try:
        import websockets  # type: ignore[import]
    except ImportError:
        return False, False, [], [], "websockets package unavailable"

    uri = f"ws://localhost:{port}"
    try:
        async with websockets.connect(uri, open_timeout=5, close_timeout=3) as ws:
            ok = await _handshake(ws, token)
            if not ok:
                # Attempt without token failed → could be auth issue.
                return True, (token is None), [], [], "Handshake failed — OpenClaw may require a token"

            agents: list[AgentInfo] = []
            sessions: list[SessionInfo] = []

            resp = await _rpc(ws, "agents.list", {}, "oc-agents")
            if resp and resp.get("ok"):
                agents = _parse_agents(resp.get("payload") or {})

            resp = await _rpc(ws, "sessions.describe", {}, "oc-sessions")
            if resp and resp.get("ok"):
                sessions = _parse_sessions(resp.get("payload") or {})

            return True, False, agents, sessions, None

    except OSError:
        # Connection refused — OpenClaw not running yet.
        return False, False, [], [], None
    except Exception as exc:
        logger.debug("OpenClaw poll error: %s", exc)
        return False, False, [], [], str(exc)


async def _run_loop(port: int, token: str | None) -> None:
    global _status
    while True:
        reachable, auth_required, agents, sessions, error = await _poll_once(port, token)
        if reachable:
            _status = OpenClawStatus(
                reachable=True,
                auth_required=auth_required,
                agents=agents,
                sessions=sessions,
                error=error,
                last_ok=time.monotonic() if not error else _status.last_ok,
            )
        elif _status.reachable:
            # Was reachable before — mark as disconnected but keep last agent list.
            _status = OpenClawStatus(
                reachable=False,
                agents=_status.agents,
                error=error,
                last_ok=_status.last_ok,
            )
        await asyncio.sleep(_RECONNECT_DELAY)


def start(port: int = OPENCLAW_PORT, token: str | None = None) -> None:
    """Start the background polling task (idempotent)."""
    global _bg_task
    if _bg_task is None or _bg_task.done():
        _bg_task = asyncio.create_task(_run_loop(port, token))
