from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_api_token
from config import settings

router = APIRouter(prefix="/api/firewall", tags=["firewall"], dependencies=[Depends(require_api_token)])


def _require_lxd():
    if settings.control_mode != "lxd":
        raise HTTPException(status_code=400, detail="Firewall management requires LXD control mode")


class AddRuleRequest(BaseModel):
    port: int
    proto: str = "tcp"
    action: str = "allow"


@router.get("/status")
async def firewall_status() -> dict:
    _require_lxd()
    import asyncio
    from services import firewall as svc
    try:
        return await asyncio.to_thread(svc.get_status)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/rules")
async def list_rules() -> list[dict]:
    _require_lxd()
    import asyncio
    from services import firewall as svc
    try:
        return await asyncio.to_thread(svc.get_rules)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/rules")
async def add_rule(req: AddRuleRequest) -> dict:
    _require_lxd()
    import asyncio
    from services import firewall as svc
    try:
        await asyncio.to_thread(svc.add_rule, req.port, req.proto, req.action)
        return {"status": "added", "port": req.port, "proto": req.proto, "action": req.action}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/rules/{number}")
async def delete_rule(number: int) -> dict:
    _require_lxd()
    import asyncio
    from services import firewall as svc
    try:
        await asyncio.to_thread(svc.delete_rule, number)
        return {"status": "deleted", "number": number}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/enable")
async def enable_firewall() -> dict:
    _require_lxd()
    import asyncio
    from services import firewall as svc
    try:
        await asyncio.to_thread(svc.set_enabled, True)
        return {"status": "enabled"}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/disable")
async def disable_firewall() -> dict:
    _require_lxd()
    import asyncio
    from services import firewall as svc
    try:
        await asyncio.to_thread(svc.set_enabled, False)
        return {"status": "disabled"}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
