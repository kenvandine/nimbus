from __future__ import annotations

import psutil
from fastapi import APIRouter

from models import SystemStats
from services.docker import installed_app_ids

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/stats", response_model=SystemStats)
async def get_stats() -> SystemStats:
    return SystemStats(
        cpu_pct=psutil.cpu_percent(interval=0.1),
        mem_pct=psutil.virtual_memory().percent,
        disk_pct=psutil.disk_usage("/").percent,
        app_count=len(installed_app_ids()),
    )
