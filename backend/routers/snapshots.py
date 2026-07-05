from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_api_token
from config import settings

router = APIRouter(prefix="/api/snapshots", tags=["snapshots"], dependencies=[Depends(require_api_token)])


class CreateSnapshotRequest(BaseModel):
    name: str
    stateful: bool = False


def _get_lxd():
    if settings.control_mode != "lxd":
        raise HTTPException(status_code=400, detail="Snapshots require LXD control mode")
    from services.lxd import get_lxd_manager
    return get_lxd_manager()


@router.get("")
async def list_snapshots() -> list[dict]:
    import asyncio
    mgr = _get_lxd()
    return await asyncio.to_thread(mgr.list_snapshots)


@router.post("")
async def create_snapshot(req: CreateSnapshotRequest) -> dict:
    import asyncio
    mgr = _get_lxd()
    try:
        await asyncio.to_thread(mgr.create_snapshot, req.name, req.stateful)
    except RuntimeError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not create snapshot '{req.name}': {exc}")
    return {"status": "created", "name": req.name}


@router.delete("/{name}")
async def delete_snapshot(name: str) -> dict:
    import asyncio
    mgr = _get_lxd()
    try:
        await asyncio.to_thread(mgr.delete_snapshot, name)
    except RuntimeError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not delete snapshot '{name}': {exc}")
    return {"status": "deleted", "name": name}


@router.post("/{name}/restore")
async def restore_snapshot(name: str) -> dict:
    import asyncio
    mgr = _get_lxd()
    try:
        await asyncio.to_thread(mgr.restore_snapshot, name)
    except RuntimeError as exc:
        # Raised for known conditions: missing container or snapshot.
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not restore snapshot '{name}': {exc}")
    return {"status": "restored", "name": name}
