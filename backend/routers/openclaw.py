from __future__ import annotations

from fastapi import APIRouter, Depends

from auth import require_api_token
from services.model_provider import get_state as get_provider_state
from services.openclaw import get_status

router = APIRouter(prefix="/api/openclaw", tags=["openclaw"], dependencies=[Depends(require_api_token)])


@router.get("/status")
async def openclaw_status() -> dict:
    s = get_status()
    p = get_provider_state()
    provider_block = {
        "provider": p.provider,
        "status": p.status,
        "model": p.model,
        "percent": p.percent,
        "file_index": p.file_index,
        "total_files": p.total_files,
        "error": p.error,
    }
    return {
        "reachable": s.reachable,
        "auth_required": s.auth_required,
        "error": s.error,
        "last_ok": s.last_ok,
        "agents": [
            {"id": a.id, "name": a.name, "emoji": a.emoji, "default": a.default}
            for a in s.agents
        ],
        "sessions": [
            {"id": x.id, "agent_id": x.agent_id, "status": x.status, "summary": x.summary}
            for x in s.sessions
        ],
        "model_provider": provider_block,
        # Back-compat alias for existing frontend code that reads this key.
        "lemonade": provider_block,
    }
