from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from auth import require_api_token
from models import AppDetail
from services.icons import generate_icon_svg
from services.control_plane import get_control_plane

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
