from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response, StreamingResponse

from auth import require_api_token
from config import settings
from models import AppDetail
from services.icons import generate_icon_svg
from services.control_plane import get_control_plane
import services.control_plane as cp_module

router = APIRouter(prefix="/api/apps", tags=["apps"], dependencies=[Depends(require_api_token)])


@router.get("", response_model=list[AppDetail])
async def list_apps() -> list[AppDetail]:
    return await get_control_plane().list_apps()


@router.get("/{app_id}", response_model=AppDetail)
async def get_app(app_id: str) -> AppDetail:
    return await get_control_plane().get_app(app_id)


@router.post("/{app_id}/install", status_code=202)
async def install_app(app_id: str) -> dict:
    return await get_control_plane().request_install(app_id)


@router.post("/{app_id}/update", status_code=202)
async def update_app(app_id: str) -> dict:
    return await get_control_plane().request_update(app_id)


@router.post("/{app_id}/uninstall", status_code=200)
async def uninstall_app(app_id: str) -> dict:
    return await get_control_plane().uninstall_app(app_id)


@router.get("/installing/active", response_model=list[str])
async def active_installs() -> list[str]:
    return await get_control_plane().active_installs()


@router.post("/check-updates")
async def check_updates() -> dict:
    asyncio.create_task(cp_module._run_update_check(get_control_plane()))
    return {"status": "checking"}


@router.get("/{app_id}/icon.svg")
async def app_icon(app_id: str) -> Response:
    try:
        meta = await get_control_plane().get_app(app_id)
        name = meta.name
    except Exception:
        name = app_id
    svg = generate_icon_svg(app_id, name)
    return Response(content=svg, media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=86400"})


async def _sse_log_lines(app_id: str, tail: int):
    """Yield SSE-formatted lines from the app's containers."""
    try:
        if settings.control_mode == "lxd":
            gen = _lxd_log_stream(app_id, tail)
        else:
            from services.docker import stream_app_logs
            gen = stream_app_logs(app_id, tail)

        async for line in gen:
            yield f"data: {json.dumps({'line': line})}\n\n"
    except asyncio.CancelledError:
        return
    except Exception as exc:
        yield f"data: {json.dumps({'error': str(exc)})}\n\n"


async def _lxd_log_stream(app_id: str, tail: int):
    """Stream docker logs from inside the LXD container via lxc exec."""
    container = settings.lxd_container_name

    # Get container names from inside the LXD container.
    proc = await asyncio.create_subprocess_exec(
        "lxc", "exec", container, "--",
        "docker", "ps",
        "--filter", f"label=com.docker.compose.project={app_id}",
        "--format", "{{.Names}}",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    names = [n for n in stdout.decode().strip().splitlines() if n]
    if not names:
        return

    queue: asyncio.Queue[str | None] = asyncio.Queue()

    async def _drain_lxc(name: str) -> None:
        p = await asyncio.create_subprocess_exec(
            "lxc", "exec", container, "--",
            "docker", "logs", "--follow", f"--tail={tail}", "--timestamps", name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        assert p.stdout is not None
        try:
            async for raw in p.stdout:
                await queue.put(raw.decode(errors="replace").rstrip())
        finally:
            await queue.put(None)
            try:
                p.terminate()
            except Exception:
                pass

    for name in names:
        asyncio.create_task(_drain_lxc(name))

    exhausted = 0
    while exhausted < len(names):
        item = await queue.get()
        if item is None:
            exhausted += 1
        else:
            yield item


@router.get("/{app_id}/logs")
async def stream_logs(app_id: str, tail: int = Query(200, ge=1, le=2000)) -> StreamingResponse:
    return StreamingResponse(
        _sse_log_lines(app_id, tail),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
