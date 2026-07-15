"""Nimbus-managed model router: an always-on lemonade `collection.router` model.

Nimbus registers one stable collection, ROUTER_MODEL_NAME, in lemonade and
points every claw app's OpenAI-compatible provider config at it permanently
(see model_provider.get_provider_config()). This makes both "switch the active
local model" and "enable/disable cloud offload" transparent to every claw app —
neither operation requires telling any already-installed app about a model
change, since the collection's definition is what changes, not its name.

Two categories of state:
  - Cloud providers + API keys (encrypted at rest, $SNAP_DATA/cloud-providers.json)
  - The router's cloud-offload policy — which provider/model/toggles are active
    (plain JSON, $SNAP_COMMON/model_router.json; no secrets)

_router_ready is intentionally in-memory only: it tracks whether *this process*
has confirmed the collection is registered in the currently-running lemond, so
a boot race or a failed re-registration always fails open to the raw local
model name rather than a collection name that might not resolve.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import httpx

from services import lemonade
from services.crypto_store import load_encrypted_json, save_encrypted_json

logger = logging.getLogger(__name__)

ROUTER_MODEL_NAME = "user.NimbusModel"

CLOUD_PROVIDER_PRESETS: dict[str, dict] = {
    "fireworks": {
        "display_name": "Fireworks",
        "base_url": "https://api.fireworks.ai/inference/v1",
    },
    "openai": {
        "display_name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
    },
    "openrouter": {
        "display_name": "OpenRouter",
        "base_url": "https://openrouter.ai/api/v1",
    },
    "together": {
        "display_name": "Together",
        "base_url": "https://api.together.xyz/v1",
    },
}

_PROVIDERS_STORE_FILE = "cloud-providers.json"
_PROVIDERS_SALT_FILE = "cloud-providers-salt"

_state_dir = os.getenv("SNAP_COMMON", "/var/lib/nimbus")
_STATE_PATH = Path(_state_dir) / "model_router.json"

_DEFAULT_STATE: dict = {
    "cloud_offload_enabled": False,
    "cloud_provider": None,
    "cloud_model": None,
    "toggles": {
        "offload_tools": False,
        "offload_images": False,
        "offload_long_input": False,
        "long_input_chars": 4000,
        "offload_keywords": [],
    },
    "advanced_json": None,
}

_router_ready: bool = False


# ---------------------------------------------------------------------------
# Persisted-state accessors
# ---------------------------------------------------------------------------

def _snap_data() -> Path:
    return Path(os.environ.get("SNAP_DATA", "/var/snap/nimbus/current"))


def _providers_path() -> Path:
    return _snap_data() / _PROVIDERS_STORE_FILE


def _load_providers() -> dict[str, dict]:
    return load_encrypted_json(_providers_path(), _PROVIDERS_SALT_FILE).get("providers", {})


def _save_providers(providers: dict[str, dict]) -> None:
    save_encrypted_json(_providers_path(), {"providers": providers}, _PROVIDERS_SALT_FILE)


def _load_state() -> dict:
    try:
        data = json.loads(_STATE_PATH.read_text())
    except FileNotFoundError:
        return dict(_DEFAULT_STATE)
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Could not read model_router.json: %s", exc)
        return dict(_DEFAULT_STATE)
    merged = dict(_DEFAULT_STATE)
    merged.update(data)
    merged["toggles"] = {**_DEFAULT_STATE["toggles"], **(data.get("toggles") or {})}
    return merged


def _save_state(state: dict) -> None:
    _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _STATE_PATH.write_text(json.dumps(state, indent=2))


def list_providers() -> list[dict]:
    """Masked provider list — never returns api_key."""
    providers = _load_providers()
    return [
        {"provider": slug, "display_name": p.get("display_name", slug), "base_url": p.get("base_url", "")}
        for slug, p in providers.items()
    ]


def get_state() -> dict:
    return _load_state()


def is_ready() -> bool:
    return _router_ready


def get_router_model_name() -> str:
    return ROUTER_MODEL_NAME


# ---------------------------------------------------------------------------
# Lemonade calls: cloud provider registration
# ---------------------------------------------------------------------------

async def register_cloud_provider(provider: str, base_url: str, api_key: str, display_name: str) -> dict:
    """Persist to Nimbus's encrypted store, then POST /api/v1/install (idempotent).

    User-initiated: raises RuntimeError on lemonade failure so the caller can
    surface a definitive result. Persistence happens first so the provider is
    retried at the next reconcile even if lemonade is unreachable right now.
    """
    providers = _load_providers()
    providers[provider] = {"display_name": display_name, "base_url": base_url, "api_key": api_key}
    _save_providers(providers)

    url = f"{lemonade.LEMONADE_BASE_URL}/api/v1/install"
    body = {"backend": "cloud", "provider": provider, "base_url": base_url}
    if api_key:
        body["api_key"] = api_key
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(url, json=body)
    if r.status_code != 200:
        raise RuntimeError(f"Lemonade /v1/install HTTP {r.status_code}: {r.text[:300]}")
    return r.json()


async def remove_cloud_provider(provider: str) -> None:
    """Best-effort clear + uninstall in lemonade, then drop from the encrypted store.

    Disables cloud offload first if this provider is the active offload target,
    so Nimbus never leaves the router pointed at a model that just got evicted.
    """
    state = _load_state()
    if state.get("cloud_provider") == provider and state.get("cloud_offload_enabled"):
        await disable_cloud_offload()

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            await client.delete(f"{lemonade.LEMONADE_BASE_URL}/api/v1/cloud/auth/{provider}")
        except httpx.HTTPError as exc:
            logger.warning("Could not clear runtime cloud auth for '%s': %s", provider, exc)
        try:
            await client.post(f"{lemonade.LEMONADE_BASE_URL}/api/v1/uninstall",
                               json={"backend": "cloud", "provider": provider})
        except httpx.HTTPError as exc:
            logger.warning("Could not uninstall cloud provider '%s': %s", provider, exc)

    providers = _load_providers()
    providers.pop(provider, None)
    _save_providers(providers)


async def list_cloud_models(provider: str) -> list[dict]:
    url = f"{lemonade.LEMONADE_BASE_URL}/api/v1/models"
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.get(url)
    if r.status_code != 200:
        raise RuntimeError(f"Lemonade /v1/models HTTP {r.status_code}: {r.text[:300]}")
    data = r.json()
    models = data.get("data") if isinstance(data, dict) else data
    if not isinstance(models, list):
        return []
    return [
        {
            "id": m.get("id"),
            "labels": m.get("labels", []),
            "max_context_window": m.get("max_context_window"),
        }
        for m in models
        if isinstance(m, dict) and m.get("cloud_provider") == provider
    ]


# ---------------------------------------------------------------------------
# Routing policy construction (pure)
# ---------------------------------------------------------------------------

def build_routing_block(local_model: str, cloud_model: str | None, toggles: dict) -> dict:
    """Pure function, no I/O. Fixed rule order: tools -> images -> keywords ->
    long-input, each only contributed if its toggle is on and a cloud_model is
    configured. Always appends a catch-all last rule routing to local_model, so
    `rules` is never empty (lemonade rejects an empty rules array) whether or
    not cloud offload is active. default_model is always local_model.
    """
    rules: list[dict] = []
    if cloud_model:
        if toggles.get("offload_tools"):
            rules.append({"id": "tools", "match": {"has_tools": True}, "route_to": cloud_model})
        if toggles.get("offload_images"):
            rules.append({"id": "images", "match": {"has_images": True}, "route_to": cloud_model})
        keywords = [k.strip() for k in (toggles.get("offload_keywords") or []) if k and k.strip()]
        if keywords:
            rules.append({"id": "keywords", "match": {"keywords_any": keywords}, "route_to": cloud_model})
        if toggles.get("offload_long_input"):
            long_input_chars = int(toggles.get("long_input_chars") or 4000)
            rules.append({"id": "long-input", "match": {"min_chars": long_input_chars}, "route_to": cloud_model})

    rules.append({"id": "default-local", "match": {"min_chars": 0}, "route_to": local_model})

    candidates = [local_model, cloud_model] if cloud_model else [local_model]
    return {"candidates": candidates, "default_model": local_model, "rules": rules}


def build_router_collection_body(local_model: str, cloud_model: str | None, routing: dict) -> dict:
    components = [local_model, cloud_model] if cloud_model else [local_model]
    return {
        "version": "1",
        "model_name": ROUTER_MODEL_NAME,
        "recipe": "collection.router",
        "components": components,
        "routing": routing,
    }


async def register_router_collection(local_model: str, cloud_model: str | None, routing: dict) -> None:
    """POST /api/v1/pull — overwrites the collection in place if it already
    exists (confirmed: lemonade treats a re-pull of a collection recipe with a
    components array as an update, never requiring delete+recreate).

    On success, sets the module-level ready flag. On failure, raises with
    lemonade's validation message; the flag is left untouched, so a bad update
    doesn't erase a previously-good ready state.
    """
    global _router_ready
    body = build_router_collection_body(local_model, cloud_model, routing)
    url = f"{lemonade.LEMONADE_BASE_URL}/api/v1/pull"
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(url, json=body)
    if r.status_code != 200:
        raise RuntimeError(f"Lemonade /v1/pull HTTP {r.status_code}: {r.text[:300]}")
    _router_ready = True


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

async def reconcile_local_model_change(new_local_model: str) -> None:
    """Called when the active local model changes. Rebuilds the router's
    routing (current cloud toggles + the new local model) and re-registers it,
    so every claw app transparently starts using the new local model with no
    per-app reconfiguration. Log-and-continue: a failure here leaves the
    previous collection definition in place in lemonade rather than breaking
    claw apps that already depend on it.
    """
    state = _load_state()
    cloud_model = state.get("cloud_model") if state.get("cloud_offload_enabled") else None
    try:
        routing = build_routing_block(new_local_model, cloud_model, state.get("toggles") or {})
        await register_router_collection(new_local_model, cloud_model, routing)
    except Exception as exc:
        logger.warning("Could not reconcile model router after local model change: %s", exc)


async def apply_cloud_policy(enabled: bool, cloud_provider: str | None, cloud_model: str | None,
                              toggles: dict | None, advanced_json: str | None) -> dict:
    """User-initiated save of the cloud-offload policy. Persists first, then
    rebuilds/re-registers the router against the *current* local model. Raises
    on failure — the user is waiting for a definitive result.
    """
    state = _load_state()
    state["cloud_offload_enabled"] = bool(enabled)
    state["cloud_provider"] = cloud_provider
    state["cloud_model"] = cloud_model
    if toggles is not None:
        state["toggles"] = {**_DEFAULT_STATE["toggles"], **toggles}
    state["advanced_json"] = advanced_json
    _save_state(state)

    local_model = lemonade.get_active_model_spec()["model_name"]
    effective_cloud_model = cloud_model if enabled else None

    if advanced_json:
        routing = json.loads(advanced_json)
    else:
        routing = build_routing_block(local_model, effective_cloud_model, state["toggles"])

    await register_router_collection(local_model, effective_cloud_model, routing)
    return state


async def disable_cloud_offload() -> None:
    """Persist enabled=false (provider/model/toggles left untouched — 'saved
    but inactive'), then re-register the router with only the local model as
    a candidate. No lemonade provider/collection deregistration — they're just
    unused.
    """
    state = _load_state()
    state["cloud_offload_enabled"] = False
    _save_state(state)
    local_model = lemonade.get_active_model_spec()["model_name"]
    try:
        routing = build_routing_block(local_model, None, state.get("toggles") or {})
        await register_router_collection(local_model, None, routing)
    except Exception as exc:
        logger.warning("Could not reconcile model router after disabling cloud offload: %s", exc)


async def reconcile_on_startup() -> None:
    """Called once at boot, unconditionally — the router collection must
    always exist regardless of whether cloud offload is enabled. Re-applies
    each stored cloud provider's key (lemond's runtime key store is memory-only
    and dies on lemond restart; Nimbus's encrypted store is the durable source
    of truth), then rebuilds and re-registers the collection. Never raises —
    log-and-continue at every step, matching lemonade.ensure_model()'s style.
    """
    providers = _load_providers()
    for slug, p in providers.items():
        try:
            url = f"{lemonade.LEMONADE_BASE_URL}/api/v1/install"
            body = {"backend": "cloud", "provider": slug, "base_url": p.get("base_url", "")}
            if p.get("api_key"):
                body["api_key"] = p["api_key"]
            async with httpx.AsyncClient(timeout=30.0) as client:
                r = await client.post(url, json=body)
            if r.status_code != 200:
                logger.warning("Could not re-apply cloud provider '%s' at startup: HTTP %s", slug, r.status_code)
        except Exception as exc:
            logger.warning("Could not re-apply cloud provider '%s' at startup: %s", slug, exc)

    state = _load_state()
    cloud_model = state.get("cloud_model") if state.get("cloud_offload_enabled") else None
    try:
        local_model = lemonade.get_active_model_spec()["model_name"]
        if state.get("advanced_json") and cloud_model:
            routing = json.loads(state["advanced_json"])
        else:
            routing = build_routing_block(local_model, cloud_model, state.get("toggles") or {})
        await register_router_collection(local_model, cloud_model, routing)
    except Exception as exc:
        logger.warning("Could not register model router at startup: %s", exc)
