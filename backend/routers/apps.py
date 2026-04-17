from __future__ import annotations
import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import Response

from models import AppDetail, AppStatus
from services import docker, network, store
from services.icons import generate_icon_svg

router = APIRouter(prefix="/api/apps", tags=["apps"])
logger = logging.getLogger(__name__)

_installing: set[str] = set()
_updating: set[str] = set()


async def _status_for(app_id: str, meta=None) -> AppStatus:
    installed = app_id in docker.installed_app_ids()
    if not installed:
        return AppStatus(installed=False)

    running = await docker.is_running(app_id)
    port: Optional[int] = None
    open_url: Optional[str] = None
    if running:
        port = await docker.get_web_port(app_id)
        if not port:
            m = meta or store.get_app_meta(app_id)
            port = m.port_hint if m else None
        if port:
            host_ip = await network.get_host_ip()
            open_url = network.build_open_url(host_ip, port)

    update_available = False
    if meta and meta.version:
        installed_ver = docker.get_installed_version(app_id)
        update_available = bool(installed_ver and installed_ver != meta.version)

    return AppStatus(installed=True, running=running, port=port,
                     open_url=open_url, update_available=update_available)


def _build_detail(meta, status: AppStatus) -> AppDetail:
    data = {**meta.model_dump(), **status.model_dump()}
    if status.installed and meta.deterministic_password:
        data["default_password"] = docker.get_app_password(meta.id)
    return AppDetail(**data)


@router.get("", response_model=list[AppDetail])
async def list_apps() -> list[AppDetail]:
    metas = store.list_apps()
    statuses = await asyncio.gather(*[_status_for(m.id, m) for m in metas])
    return [_build_detail(m, s) for m, s in zip(metas, statuses)]


@router.get("/{app_id}", response_model=AppDetail)
async def get_app(app_id: str) -> AppDetail:
    meta = store.get_app_meta(app_id)
    if meta is None:
        raise HTTPException(status_code=404, detail=f"App '{app_id}' not found in store")
    status = await _status_for(app_id, meta)
    return _build_detail(meta, status)


async def _do_install(app_id: str) -> None:
    _installing.add(app_id)
    try:
        await docker.install_app(app_id)
    except Exception as exc:
        logger.error("Install failed for %s: %s", app_id, exc)
    finally:
        _installing.discard(app_id)


async def _do_update(app_id: str) -> None:
    _updating.add(app_id)
    try:
        await docker.update_app(app_id)
    except Exception as exc:
        logger.error("Update failed for %s: %s", app_id, exc)
    finally:
        _updating.discard(app_id)


@router.post("/{app_id}/install", status_code=202)
async def install_app(app_id: str, background_tasks: BackgroundTasks) -> dict:
    if store.get_app_meta(app_id) is None:
        raise HTTPException(status_code=404, detail=f"App '{app_id}' not found in store")
    if app_id in _installing:
        return {"status": "already_installing"}
    if app_id in docker.installed_app_ids():
        return {"status": "already_installed"}
    background_tasks.add_task(_do_install, app_id)
    return {"status": "installing"}


@router.post("/{app_id}/update", status_code=202)
async def update_app(app_id: str, background_tasks: BackgroundTasks) -> dict:
    if app_id not in docker.installed_app_ids():
        raise HTTPException(status_code=404, detail=f"App '{app_id}' is not installed")
    if app_id in _updating:
        return {"status": "already_updating"}
    background_tasks.add_task(_do_update, app_id)
    return {"status": "updating"}


@router.post("/{app_id}/uninstall", status_code=200)
async def uninstall_app(app_id: str) -> dict:
    if app_id not in docker.installed_app_ids():
        raise HTTPException(status_code=404, detail=f"App '{app_id}' is not installed")
    await docker.uninstall_app(app_id)
    return {"status": "uninstalled"}


@router.get("/installing/active", response_model=list[str])
async def active_installs() -> list[str]:
    return list(_installing)


@router.get("/{app_id}/icon.svg")
async def app_icon(app_id: str) -> Response:
    meta = store.get_app_meta(app_id)
    name = meta.name if meta else app_id
    svg = generate_icon_svg(app_id, name)
    return Response(content=svg, media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=86400"})
