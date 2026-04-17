from __future__ import annotations
from pathlib import Path

import psutil
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

from models import SystemStats
from services.docker import installed_app_ids

router = APIRouter(prefix="/api/system", tags=["system"])

# Caddy writes its local CA cert here when running as the 'caddy' user
_CADDY_CA_CERT = Path("/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt")


@router.get("/stats", response_model=SystemStats)
async def get_stats() -> SystemStats:
    return SystemStats(
        cpu_pct=psutil.cpu_percent(interval=0.1),
        mem_pct=psutil.virtual_memory().percent,
        disk_pct=psutil.disk_usage("/").percent,
        app_count=len(installed_app_ids()),
    )


@router.get("/ca-cert")
async def get_ca_cert() -> Response:
    """Download Caddy's local root CA certificate for client trust installation."""
    if not _CADDY_CA_CERT.exists():
        raise HTTPException(status_code=404, detail="CA certificate not yet generated — Caddy may still be starting up")
    return FileResponse(
        path=_CADDY_CA_CERT,
        media_type="application/x-x509-ca-cert",
        filename="nimbus-ca.crt",
    )
