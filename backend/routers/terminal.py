from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import pty
import shutil
import struct
import termios
from pathlib import Path

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from config import settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["terminal"])


def _find_lxc() -> str:
    """Locate the lxc binary."""
    for candidate in [
        shutil.which("lxc"),
        "/snap/bin/lxc",
        "/usr/bin/lxc",
    ]:
        if candidate and Path(candidate).exists():
            return candidate
    raise FileNotFoundError("lxc binary not found; ensure the lxd snap is installed")


def _set_pty_size(fd: int, cols: int, rows: int) -> None:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except Exception:
        pass


async def _open_lxc_pty(container: str, cols: int, rows: int):
    """Fork lxc exec with a PTY. Returns (master_fd, process)."""
    lxc = _find_lxc()
    master_fd, slave_fd = os.openpty()
    _set_pty_size(slave_fd, cols, rows)

    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["COLUMNS"] = str(cols)
    env["LINES"] = str(rows)

    proc = await asyncio.create_subprocess_exec(
        lxc, "exec", container,
        "--env", f"TERM=xterm-256color",
        "--env", f"COLUMNS={cols}",
        "--env", f"LINES={rows}",
        "--", "/bin/bash", "-l",
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        env=env,
        preexec_fn=os.setsid,
        close_fds=True,
    )
    os.close(slave_fd)
    return master_fd, proc


@router.websocket("/ws/terminal")
async def terminal_ws(
    websocket: WebSocket,
    token: str = Query(default=""),
) -> None:
    from auth import SESSION_COOKIE
    from services.auth import verify_session_token, account_exists

    # Prefer the session cookie (sent automatically by the browser) over the
    # query param token.  The cookie is more reliable — the query param can be
    # empty when auth status hasn't loaded yet in the frontend.
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

    master_fd: int | None = None
    proc = None
    try:
        master_fd, proc = await _open_lxc_pty(
            settings.lxd_container_name, cols=80, rows=24
        )

        loop = asyncio.get_running_loop()

        async def pty_to_ws():
            """Read PTY output and forward to WebSocket."""
            while True:
                try:
                    data = await loop.run_in_executor(None, _read_pty, master_fd)
                    if data is None:
                        break
                    await websocket.send_bytes(data)
                except (OSError, WebSocketDisconnect):
                    break

        async def ws_to_pty():
            """Receive from WebSocket and write to PTY or handle control messages."""
            nonlocal master_fd
            while True:
                try:
                    msg = await websocket.receive()
                except WebSocketDisconnect:
                    break

                if msg["type"] == "websocket.disconnect":
                    break

                if "bytes" in msg and msg["bytes"]:
                    try:
                        os.write(master_fd, msg["bytes"])
                    except OSError:
                        break
                elif "text" in msg and msg["text"]:
                    try:
                        ctrl = json.loads(msg["text"])
                        if ctrl.get("type") == "resize":
                            cols = int(ctrl.get("cols", 80))
                            rows = int(ctrl.get("rows", 24))
                            _set_pty_size(master_fd, cols, rows)
                    except (json.JSONDecodeError, OSError):
                        pass

        reader = asyncio.create_task(pty_to_ws())
        writer = asyncio.create_task(ws_to_pty())

        done, pending = await asyncio.wait(
            [reader, writer], return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()

    except FileNotFoundError as exc:
        logger.warning("Terminal unavailable: %s", exc)
        try:
            await websocket.send_text(json.dumps({"error": str(exc)}))
        except Exception:
            pass
    except Exception as exc:
        logger.error("Terminal session error: %s", exc)
    finally:
        if master_fd is not None:
            try:
                os.close(master_fd)
            except OSError:
                pass
        if proc is not None:
            try:
                proc.terminate()
            except Exception:
                pass
        try:
            await websocket.close()
        except Exception:
            pass


def _read_pty(fd: int, size: int = 4096) -> bytes | None:
    """Blocking PTY read — run in executor."""
    try:
        return os.read(fd, size)
    except OSError:
        return None
