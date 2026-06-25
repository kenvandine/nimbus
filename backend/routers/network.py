from __future__ import annotations

import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_api_token
from services import wifi as wifi_service
from services import network as network_service

router = APIRouter(
    prefix="/api/network",
    tags=["network"],
    dependencies=[Depends(require_api_token)],
)


class ConnectRequest(BaseModel):
    ssid: str
    password: Optional[str] = None


@router.get("/addresses")
async def network_addresses() -> list[dict]:
    return await asyncio.to_thread(network_service.get_all_addresses)


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
    # Check if the Nimbus AP is currently active
    ap_active = await asyncio.to_thread(wifi_service.is_ap_active)
    if ap_active:
        # Schedule the transition in the background
        asyncio.create_task(wifi_service.handover_ap_to_wifi(req.ssid, req.password))
        return {"status": "transitioning", "ssid": req.ssid}

    try:
        await asyncio.to_thread(wifi_service.connect_network, req.ssid, req.password)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": "connected", "ssid": req.ssid}


@router.post("/wifi/disconnect")
async def wifi_disconnect() -> dict:
    try:
        await asyncio.to_thread(wifi_service.disconnect_network)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": "disconnected"}


class DnsRequest(BaseModel):
    servers: list[str]


@router.get("/dns")
async def get_dns() -> dict:
    servers = await asyncio.to_thread(network_service.get_dns_servers)
    return {"servers": servers}


@router.put("/dns")
async def set_dns(req: DnsRequest) -> dict:
    if not req.servers:
        raise HTTPException(status_code=422, detail="At least one DNS server required")
    try:
        await asyncio.to_thread(network_service.set_dns_servers, req.servers)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    return {"status": "ok", "servers": req.servers}
