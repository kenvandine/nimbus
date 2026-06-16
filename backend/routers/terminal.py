from __future__ import annotations

import asyncio
import json
import logging
import os
import socket

import websocket as _ws  # websocket-client (bundled with pylxd)

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from config import settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["terminal"])

# Persistent session — survives browser disconnects so the shell context
# (cwd, history, running processes) is preserved when the window re-opens.
_session: _TerminalSession | None = None
_session_lock = asyncio.Lock()


class _TerminalSession:
    """LXD exec session that outlives individual browser connections.

    Output received while no browser is connected is buffered (up to
    MAX_BUFFER bytes) and flushed to the next browser that attaches.
    """

    MAX_BUFFER = 128 * 1024  # 128 KB

    def __init__(self, io_ws: _ws.WebSocket, ctrl_ws: _ws.WebSocket) -> None:
        self._io_ws = io_ws
        self._ctrl_ws = ctrl_ws
        self._missed: bytearray = bytearray()
        self._queue: asyncio.Queue[bytes | None] | None = None
        self.alive = True

    def start(self) -> None:
        asyncio.create_task(self._reader())

    async def _reader(self) -> None:
        loop = asyncio.get_running_loop()
        while self.alive:
            try:
                data = await loop.run_in_executor(None, self._io_ws.recv)
                if not data:
                    break
                if isinstance(data, str):
                    data = data.encode()
                if self._queue is not None:
                    await self._queue.put(data)
                else:
                    self._missed.extend(data)
                    if len(self._missed) > self.MAX_BUFFER:
                        del self._missed[: len(self._missed) - self.MAX_BUFFER]
            except Exception:
                break
        self.alive = False
        if self._queue is not None:
            await self._queue.put(None)  # signal EOF to attached browser

    def attach(self) -> asyncio.Queue[bytes | None]:
        """Attach a browser. Returns a queue; missed output is pre-loaded."""
        q: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._queue = q
        if self._missed:
            q.put_nowait(bytes(self._missed))
            self._missed.clear()
        return q

    def detach(self) -> None:
        self._queue = None

    def close(self) -> None:
        self.alive = False
        for wsc in (self._io_ws, self._ctrl_ws):
            try:
                wsc.close()
            except Exception:
                pass


def _lxd_socket_path() -> str:
    lxd_dir = os.environ.get("LXD_DIR", "/var/snap/lxd/common/lxd")
    return os.path.join(lxd_dir, "unix.socket")


def _start_exec(container: str, cols: int, rows: int) -> tuple[str, dict]:
    """POST exec request to LXD API. Returns (operation_id, fds)."""
    from services.lxd import get_lxd_manager

    manager = get_lxd_manager()
    client = manager.client()
    resp = client.api.instances[container].exec.post(json={
        "command": ["sudo", "-u", "nimbus", "-i"],
        "environment": {
            "TERM": "xterm-256color",
            "COLUMNS": str(cols),
            "LINES": str(rows),
        },
        "wait-for-websocket": True,
        "interactive": True,
        "width": cols,
        "height": rows,
    })
    data = resp.json()
    op_id = data["metadata"]["id"]
    fds = data["metadata"]["metadata"]["fds"]
    return op_id, fds


def _open_lxd_ws(op_id: str, secret: str) -> _ws.WebSocket:
    """Open a WebSocket to LXD over the Unix domain socket."""
    path = f"/1.0/operations/{op_id}/websocket?secret={secret}"
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(_lxd_socket_path())
    wsc = _ws.WebSocket()
    wsc.connect(f"ws://localhost{path}", socket=sock, host="localhost")
    return wsc


@router.websocket("/ws/terminal")
async def terminal_ws(
    websocket: WebSocket,
    token: str = Query(default=""),
) -> None:
    global _session

    from auth import SESSION_COOKIE
    from services.auth import verify_session_token, account_exists

    cookie_token = websocket.cookies.get(SESSION_COOKIE, "")
    effective_token = cookie_token or token

    if account_exists():
        username = verify_session_token(effective_token)
        if not username:
            if not (settings.api_token and effective_token == settings.api_token):
                await websocket.accept()
                await websocket.send_text(
                    json.dumps({"error": "Authentication required — please log in and try again"})
                )
                await websocket.close(code=4001)
                return

    if settings.control_mode != "lxd":
        await websocket.accept()
        await websocket.send_text(
            json.dumps({"error": "Terminal is only available in LXD mode"})
        )
        await websocket.close(code=4003)
        return

    await websocket.accept()
    loop = asyncio.get_running_loop()

    async with _session_lock:
        if _session is None or not _session.alive:
            cols, rows = 80, 24
            try:
                op_id, fds = await loop.run_in_executor(
                    None, _start_exec, settings.lxd_container_name, cols, rows
                )
                io_ws = await loop.run_in_executor(None, _open_lxd_ws, op_id, fds["0"])
                ctrl_ws = await loop.run_in_executor(None, _open_lxd_ws, op_id, fds["control"])
            except Exception as exc:
                logger.error("Failed to start LXD exec session: %s", exc)
                try:
                    await websocket.send_text(json.dumps({"error": f"Failed to start terminal: {exc}"}))
                except Exception:
                    pass
                return
            _session = _TerminalSession(io_ws, ctrl_ws)
            _session.start()
            logger.info("Started new terminal session")
        else:
            logger.info("Reattaching to existing terminal session")

    session = _session
    queue = session.attach()

    try:
        async def queue_to_browser() -> None:
            while True:
                data = await queue.get()
                if data is None:
                    break
                try:
                    await websocket.send_bytes(data)
                except Exception:
                    break

        async def browser_to_lxd() -> None:
            while True:
                try:
                    msg = await websocket.receive()
                except WebSocketDisconnect:
                    break
                if msg["type"] == "websocket.disconnect":
                    break
                if "bytes" in msg and msg["bytes"]:
                    raw = msg["bytes"]
                    try:
                        await loop.run_in_executor(
                            None, lambda d=raw: session._io_ws.send_binary(d)
                        )
                    except Exception:
                        break
                elif "text" in msg and msg["text"]:
                    try:
                        ctrl = json.loads(msg["text"])
                        if ctrl.get("type") == "resize":
                            c = int(ctrl.get("cols", 80))
                            r = int(ctrl.get("rows", 24))
                            resize = json.dumps({
                                "command": "window-resize",
                                "args": {"width": c, "height": r},
                            })
                            await loop.run_in_executor(
                                None, lambda s=resize: session._ctrl_ws.send(s)
                            )
                    except Exception:
                        pass

        reader = asyncio.create_task(queue_to_browser())
        writer = asyncio.create_task(browser_to_lxd())
        done, pending = await asyncio.wait([reader, writer], return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()

    except Exception as exc:
        logger.error("Terminal session error: %s", exc)
    finally:
        session.detach()
        # Keep the LXD session alive so the shell context persists.
        # Only close it if the shell itself has exited (session.alive is False).
        if not session.alive:
            session.close()
        try:
            await websocket.close()
        except Exception:
            pass
