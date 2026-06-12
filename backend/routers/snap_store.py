"""AI Labs snap store router."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from auth import require_api_token
from services import container_snaps, snap_store

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/snap-store",
    tags=["snap-store"],
    dependencies=[Depends(require_api_token)],
)


class InstallRequest(BaseModel):
    name: str
    channel: str = "stable"


class RefreshRequest(BaseModel):
    channel: str | None = None


def _get_lxd_manager():
    from config import settings
    if settings.control_mode != "lxd":
        return None
    from services.lxd import get_lxd_manager
    return get_lxd_manager()


@router.get("/catalog")
async def get_catalog() -> dict[str, Any]:
    """Return the AI Labs snap catalog with Snap Store metadata and install status."""
    catalog = await snap_store.get_catalog_with_metadata()
    installed = {s["name"]: s for s in await container_snaps.list_container_snaps()}

    for snap in catalog["snaps"]:
        name = snap["name"]
        if name in installed:
            snap["installed"] = True
            snap["installed_version"] = installed[name].get("version", "")
            snap["installed_revision"] = installed[name].get("revision", "")
            snap["tracking"] = installed[name].get("tracking", "")
        else:
            snap["installed"] = False

    return catalog


@router.post("/install")
async def install_snap(req: InstallRequest) -> dict[str, Any]:
    """Install a snap in the LXD container."""
    catalog = snap_store.load_catalog()
    allowed = {s["name"] for s in catalog.get("snaps", [])}
    if req.name not in allowed:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail=f"'{req.name}' is not in the AI Labs catalog")

    # Check port conflicts before installing
    ports = snap_store.get_snap_ports(req.name)
    manager = _get_lxd_manager()
    if manager and ports:
        conflicts = await asyncio.to_thread(manager.get_conflicting_ports, req.name, ports)
        if conflicts:
            conflict_ports = ", ".join(str(p) for p in conflicts)
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail=f"Port(s) {conflict_ports} are already in use by another installed app",
            )

    # Determine if classic confinement is required
    try:
        meta = await snap_store.fetch_snap_metadata(req.name)
        classic = meta.get("confinement") == "classic"
    except Exception:
        classic = False

    try:
        result = await container_snaps.install_container_snap(req.name, req.channel, classic=classic)
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    if not result.get("ok"):
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=result.get("stderr", "install failed"))

    # Set up LXD port proxy devices for the snap's ports
    if manager and ports:
        try:
            await asyncio.to_thread(manager.setup_snap_port_proxies, req.name, ports)
        except Exception as exc:
            logger.warning("Could not set up port proxies for snap '%s': %s", req.name, exc)

    return result


@router.delete("/{name}")
async def remove_snap(name: str) -> dict[str, Any]:
    """Remove a snap from the LXD container."""
    try:
        result = await container_snaps.remove_container_snap(name)
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    if not result.get("ok"):
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=result.get("stderr", "remove failed"))

    # Tear down LXD port proxy devices
    ports = snap_store.get_snap_ports(name)
    manager = _get_lxd_manager()
    if manager and ports:
        try:
            await asyncio.to_thread(manager.teardown_snap_port_proxies, name, ports)
        except Exception as exc:
            logger.warning("Could not tear down port proxies for snap '%s': %s", name, exc)

    return result


@router.post("/{name}/refresh")
async def refresh_snap(name: str, req: RefreshRequest) -> dict[str, Any]:
    """Refresh a snap in the LXD container."""
    try:
        result = await container_snaps.refresh_container_snap(name, req.channel)
    except Exception as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    if not result.get("ok"):
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail=result.get("stderr", "refresh failed"))
    return result
