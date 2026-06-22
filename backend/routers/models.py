from __future__ import annotations

import asyncio

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
    """Return all known model specs with their download status."""
    from services import lemonade
    results = await asyncio.gather(
        *[lemonade.is_model_installed(m["model_name"]) for m in lemonade.KNOWN_MODELS],
        return_exceptions=True,
    )
    return [
        {
            "model_name": m.get("model_name", ""),
            "checkpoint": m.get("checkpoint", ""),
            "labels": m.get("labels", []),
            "recipe": m.get("recipe", ""),
            "downloaded": result is True,
        }
        for m, result in zip(lemonade.KNOWN_MODELS, results)
    ]


@router.post("/pull")
async def pull_model() -> dict:
    from services import lemonade
    try:
        spec = lemonade.get_active_model_spec()
        asyncio.create_task(lemonade.pull_model(spec))
        return {"status": "pulling", "model_name": spec.get("model_name", "")}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/ensure")
async def ensure_model() -> dict:
    from services import lemonade
    try:
        asyncio.create_task(lemonade.ensure_default_model())
        return {"status": "ensuring"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


class SelectModelRequest(BaseModel):
    model_name: str


@router.post("/select")
async def select_model(body: SelectModelRequest) -> dict:
    """Switch the active AI model, pull it if needed, then re-run lemonade --auto
    for every installed claw app.
    """
    from services import lemonade, control_plane as cp
    spec = lemonade.KNOWN_MODELS_BY_NAME.get(body.model_name)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Unknown model: {body.model_name!r}")
    lemonade.set_model_override(spec)

    async def _task() -> None:
        await lemonade.ensure_model(spec)
        if lemonade.get_pull_state().status == "ready":
            await cp.run_lemonade_autoconfig()

    asyncio.create_task(_task())
    return {"status": "selecting", "model_name": body.model_name}
