from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from auth import require_api_token
from models import SystemStats
from services.control_plane import get_control_plane

router = APIRouter(prefix="/api/system", tags=["system"], dependencies=[Depends(require_api_token)])


@router.get("/stats", response_model=SystemStats)
async def get_stats() -> SystemStats:
    return await get_control_plane().get_stats()


@router.get("/ca-cert")
async def get_ca_cert() -> Response:
    content, media_type, filename = await get_control_plane().get_ca_cert()
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
