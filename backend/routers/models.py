from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_api_token

router = APIRouter(prefix="/api/models", tags=["models"], dependencies=[Depends(require_api_token)])


@router.get("/status")
async def model_status() -> dict:
    from services import model_provider, lemonade
    try:
        provider = model_provider.current_provider()
        config = model_provider.get_provider_config()
        state = model_provider.get_state()
        lemon_status = await lemonade.status()
        pull_state = lemonade.get_pull_state()
        return {
            "provider": provider,
            "model_id": config.model_id,
            "base_url": config.base_url,
            "status": state.status,
            "model": state.model,
            "error": state.error,
            "lemonade": {
                "reachable": lemon_status.reachable,
                "error": lemon_status.error,
            },
            "pull": {
                "status": pull_state.status,
                "model": pull_state.model,
                "percent": pull_state.percent,
                "file_index": pull_state.file_index,
                "total_files": pull_state.total_files,
                "error": pull_state.error,
            },
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/available")
async def list_available_models() -> list[dict]:
    from services import lemonade
    model = lemonade.DEFAULT_MODEL
    return [
        {
            "model_name": model.get("model_name", ""),
            "checkpoint": model.get("checkpoint", ""),
            "labels": model.get("labels", []),
            "recipe": model.get("recipe", ""),
        }
    ]


@router.post("/pull")
async def pull_model() -> dict:
    from services import lemonade
    try:
        spec = lemonade.DEFAULT_MODEL
        import asyncio
        asyncio.create_task(lemonade.pull_model(spec))
        return {"status": "pulling", "model_name": spec.get("model_name", "")}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/ensure")
async def ensure_model() -> dict:
    from services import lemonade
    try:
        import asyncio
        asyncio.create_task(lemonade.ensure_default_model())
        return {"status": "ensuring"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
