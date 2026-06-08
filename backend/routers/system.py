from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response, StreamingResponse

from auth import require_api_token
from config import settings
from models import SystemStats
from services.control_plane import get_control_plane
from services.device import mark_oobe_complete

_LXC_AGENT_PORT = 9001
_HOST_LOG_FILE = Path(os.environ.get("SNAP_COMMON", "")) / "nimbus.log" if os.environ.get("SNAP_COMMON") else None

router = APIRouter(prefix="/api/system", tags=["system"], dependencies=[Depends(require_api_token)])


@router.get("/stats", response_model=SystemStats)
async def get_stats() -> SystemStats:
    return await get_control_plane().get_stats()


@router.post("/restart")
async def restart_system() -> dict:
    return await get_control_plane().restart_system()


@router.post("/poweroff")
async def power_off_system() -> dict:
    return await get_control_plane().power_off_system()


@router.post("/update")
async def update_system() -> dict:
    return await get_control_plane().update_system()


@router.post("/oobe-complete")
async def oobe_complete() -> dict:
    mark_oobe_complete()
    return {"status": "ok"}


async def _journal_sse(source: str, lines: int):
    if source == "lxc":
        # Proxy SSE from the LXC agent daemon (reachable via the LXD proxy device).
        url = f"http://localhost:{_LXC_AGENT_PORT}/journal?lines={lines}"
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("GET", url) as resp:
                    async for chunk in resp.aiter_bytes():
                        if chunk:
                            yield chunk
        except asyncio.CancelledError:
            return
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
    else:
        # Tail $SNAP_COMMON/nimbus.log — written by main.py's RotatingFileHandler.
        # This avoids the system-observe plug requirement that journalctl needs.
        if not _HOST_LOG_FILE or not _HOST_LOG_FILE.exists():
            yield f"data: {json.dumps({'error': 'Log file not found — restart the Nimbus service to create it.'})}\n\n"
            return
        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                "tail", "-F", "-n", str(lines), str(_HOST_LOG_FILE),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            assert proc.stdout is not None
            async for raw in proc.stdout:
                yield f"data: {json.dumps({'line': raw.decode(errors='replace').rstrip()})}\n\n"
        except asyncio.CancelledError:
            return
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
        finally:
            if proc is not None:
                try:
                    proc.terminate()
                except Exception:
                    pass


@router.get("/journal")
async def stream_journal(
    source: str = Query("host", pattern="^(host|lxc)$"),
    lines: int = Query(200, ge=1, le=2000),
) -> StreamingResponse:
    return StreamingResponse(
        _journal_sse(source, lines),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/ca-cert")
async def get_ca_cert() -> Response:
    content, media_type, filename = await get_control_plane().get_ca_cert()
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
