from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_api_token

router = APIRouter(prefix="/api/keys", tags=["keys"], dependencies=[Depends(require_api_token)])


class SetKeyRequest(BaseModel):
    name: str
    value: str


@router.get("")
async def list_keys() -> list[dict]:
    import asyncio
    from services import api_keys as svc
    try:
        return await asyncio.to_thread(svc.list_keys)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("")
async def set_key(req: SetKeyRequest) -> dict:
    import asyncio
    from services import api_keys as svc
    if not req.name.strip():
        raise HTTPException(status_code=422, detail="Key name cannot be empty")
    try:
        await asyncio.to_thread(svc.set_key, req.name.strip(), req.value)
        return {"status": "saved", "name": req.name.strip()}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/{name}")
async def delete_key(name: str) -> dict:
    import asyncio
    from services import api_keys as svc
    try:
        await asyncio.to_thread(svc.delete_key, name)
        return {"status": "deleted", "name": name}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
