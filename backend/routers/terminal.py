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


def _lxd_socket_path() -> str:
    lxd_dir = os.environ.get("LXD_DIR", "/var/snap/lxd/common/lxd")
    return os.path.join(lxd_dir, "unix.socket")


def _start_exec(container: str, cols: int, rows: int) -> tuple[str, dict]:
    """POST exec request to LXD API. Returns (operation_id, fds)."""
    from services.lxd import get_lxd_manager

    manager = get_lxd_manager()
    client = manager.client()
    resp = client.api.instances[container].exec.post(json={
        "command": ["/bin/bash", "-l"],
        "environment": {
            "TERM": "xterm-256color",
            "HOME": "/root",
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
    from auth import SESSION_COOKIE
    from services.auth import verify_session_token, account_exists

    # Session cookie is more reliable than the query-param token — the browser
    # sends it automatically even before the frontend has populated authStatus.
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
    cols, rows = 80, 24

    try:
        op_id, fds = await loop.run_in_executor(
            None, _start_exec, settings.lxd_container_name, cols, rows
        )
    except Exception as exc:
        logger.error("Failed to start LXD exec session: %s", exc)
        try:
            await websocket.send_text(json.dumps({"error": f"Failed to start terminal: {exc}"}))
        except Exception:
            pass
        return

    io_ws: _ws.WebSocket | None = None
    ctrl_ws: _ws.WebSocket | None = None

    try:
        io_ws = await loop.run_in_executor(None, _open_lxd_ws, op_id, fds["0"])
        ctrl_ws = await loop.run_in_executor(None, _open_lxd_ws, op_id, fds["control"])

        async def lxd_to_browser():
            while True:
                try:
                    data = await loop.run_in_executor(None, io_ws.recv)
                    if not data:
                        break
                    if isinstance(data, str):
                        data = data.encode()
                    await websocket.send_bytes(data)
                except (WebSocketDisconnect, OSError):
                    break
                except _ws.WebSocketConnectionClosedException:
                    break
                except Exception as exc:
                    logger.debug("lxd_to_browser error: %s", exc)
                    break

        async def browser_to_lxd():
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
                        await loop.run_in_executor(None, lambda d=raw: io_ws.send_binary(d))
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
                                None, lambda s=resize: ctrl_ws.send(s)
                            )
                    except Exception:
                        pass

        reader = asyncio.create_task(lxd_to_browser())
        writer = asyncio.create_task(browser_to_lxd())
        done, pending = await asyncio.wait([reader, writer], return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()

    except Exception as exc:
        logger.error("Terminal session error: %s", exc)
    finally:
        # Closing the LXD websockets unblocks any recv() running in executor threads.
        for ws in (io_ws, ctrl_ws):
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass
        try:
            await websocket.close()
        except Exception:
            pass
