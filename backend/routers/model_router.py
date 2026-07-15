from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_api_token

router = APIRouter(prefix="/api/cloud", tags=["cloud"], dependencies=[Depends(require_api_token)])


@router.get("/presets")
async def list_presets() -> dict:
    from services import model_router as svc
    return svc.CLOUD_PROVIDER_PRESETS


@router.get("/providers")
async def list_providers() -> list[dict]:
    from services import model_router as svc
    return await asyncio.to_thread(svc.list_providers)


class AddProviderRequest(BaseModel):
    provider: str
    display_name: str
    base_url: str
    api_key: str = ""


@router.post("/providers")
async def add_provider(body: AddProviderRequest) -> dict:
    from services import model_router as svc
    if not body.provider.strip() or not body.base_url.strip():
        raise HTTPException(status_code=422, detail="provider and base_url are required")
    try:
        result = await svc.register_cloud_provider(
            body.provider.strip(), body.base_url.strip(), body.api_key, body.display_name.strip() or body.provider
        )
        return {"status": "added", "provider": body.provider, **result}
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/providers/{provider}")
async def delete_provider(provider: str) -> dict:
    from services import model_router as svc
    try:
        await svc.remove_cloud_provider(provider)
        return {"status": "removed", "provider": provider}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/providers/{provider}/models")
async def provider_models(provider: str) -> list[dict]:
    from services import model_router as svc
    try:
        return await svc.list_cloud_models(provider)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/status")
async def status() -> dict:
    from services import lemonade, model_router as svc
    try:
        state = svc.get_state()
        lemon_status = await lemonade.status()
        return {
            "cloud_offload_enabled": state.get("cloud_offload_enabled", False),
            "active": state.get("cloud_offload_enabled", False) and svc.is_ready(),
            "cloud_provider": state.get("cloud_provider"),
            "cloud_model": state.get("cloud_model"),
            "toggles": state.get("toggles", {}),
            "advanced_json": state.get("advanced_json"),
            "local_model_id": lemonade.get_active_model_spec().get("model_name"),
            "router_model_name": svc.get_router_model_name(),
            "router_ready": svc.is_ready(),
            "lemonade_reachable": lemon_status.reachable,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


class PolicyRequest(BaseModel):
    enabled: bool
    cloud_provider: str | None = None
    cloud_model: str | None = None
    toggles: dict | None = None
    advanced_json: str | None = None


@router.post("/policy")
async def save_policy(body: PolicyRequest) -> dict:
    from services import model_router as svc, control_plane as cp
    try:
        state = await svc.apply_cloud_policy(
            body.enabled, body.cloud_provider, body.cloud_model, body.toggles, body.advanced_json
        )
        # Repoint any app still configured with a raw local model name (apps
        # onboarded during the bootstrap window before the router collection's
        # first registration) at the collection, so the saved policy actually
        # applies to it. Background — re-onboarding every claw app can take a
        # while and the policy itself is already saved and registered.
        asyncio.create_task(cp.run_lemonade_autoconfig())
        return {"status": "saved", **state}
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
