from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_api_token

router = APIRouter(prefix="/api/ssh", tags=["ssh"], dependencies=[Depends(require_api_token)])


class AddKeyRequest(BaseModel):
    pubkey: str


@router.get("/status")
async def ssh_status() -> dict:
    import asyncio
    from services import ssh as svc
    try:
        return await asyncio.to_thread(svc.get_ssh_status)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/keys")
async def list_keys() -> list[dict]:
    import asyncio
    from services import ssh as svc
    try:
        return await asyncio.to_thread(svc.list_authorized_keys)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/keys")
async def add_key(req: AddKeyRequest) -> dict:
    import asyncio
    from services import ssh as svc
    try:
        fingerprint = await asyncio.to_thread(svc.add_authorized_key, req.pubkey)
        return {"status": "added", "fingerprint": fingerprint}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/keys/{fingerprint:path}")
async def remove_key(fingerprint: str) -> dict:
    import asyncio
    from services import ssh as svc
    try:
        await asyncio.to_thread(svc.remove_authorized_key, fingerprint)
        return {"status": "removed", "fingerprint": fingerprint}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
