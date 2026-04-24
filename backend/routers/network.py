from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_api_token
from services import wifi as wifi_service

router = APIRouter(
    prefix="/api/network",
    tags=["network"],
    dependencies=[Depends(require_api_token)],
)


class ConnectRequest(BaseModel):
    ssid: str
    password: Optional[str] = None


@router.get("/wifi/status")
async def wifi_status() -> dict:
    status = await asyncio.to_thread(wifi_service.get_wifi_status)
    return {
        "available": status.available,
        "enabled": status.enabled,
        "connected": status.connected,
        "ssid": status.ssid,
        "ip_address": status.ip_address,
        "error": status.error,
    }


@router.get("/wifi/networks")
async def wifi_networks() -> list[dict]:
    aps = await asyncio.to_thread(wifi_service.scan_networks)
    return [
        {
            "ssid": ap.ssid,
            "strength": ap.strength,
            "secured": ap.secured,
            "in_use": ap.in_use,
            "known": ap.known,
        }
        for ap in aps
    ]


@router.post("/wifi/connect")
async def wifi_connect(req: ConnectRequest) -> dict:
    try:
        await asyncio.to_thread(wifi_service.connect_network, req.ssid, req.password)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": "connecting", "ssid": req.ssid}


@router.post("/wifi/disconnect")
async def wifi_disconnect() -> dict:
    try:
        await asyncio.to_thread(wifi_service.disconnect_network)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": "disconnected"}
