"""Client for the Lemonade Server REST API (https://lemonade-server.ai).

Lemonade runs as a host snap on http://localhost:13305 and serves models with
an OpenAI-compatible API. Nimbus uses it as the local-LLM backend behind
OpenClaw — when the user installs OpenClaw, we pre-pull and load the default
model so the wizard's preselected provider has something to talk to.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import httpx

from constants import LEMONADE_PORT

logger = logging.getLogger(__name__)

LEMONADE_BASE_URL = os.getenv("NIMBUS_LEMONADE_BASE_URL", "http://localhost:13305")

# ---------------------------------------------------------------------------
# Recipe catalog
# ---------------------------------------------------------------------------

# GitHub API endpoint for the openclaw recipe directory.
_RECIPE_CATALOG_URL = (
    "https://api.github.com/repos/kenvandine/recipes/contents/openclaw"
    "?ref=openclaw_recipes"
)
_RECIPE_CACHE_TTL = 3600  # seconds

# Hardcoded fallback specs — used when GitHub is unreachable.
# The 35B MoE is used on AMD RYZEN AI devices with ≥64 GB RAM; everything else
# gets the 9B.
_MODEL_35B: dict = {
    "model_name":     "user.Qwen3.6-35B-A3B-MTP-GGUF",
    "checkpoints":    {"main": "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
                       "mmproj": "mmproj-F16.gguf"},
    "labels":         ["vision", "tool-calling"],
    "recipe":         "llamacpp",
    "recipe_options": {"ctx_size": 32768},
    "size":           22.7,
}

_MODEL_9B: dict = {
    "model_name":     "user.Qwen3.5-9B-GGUF",
    "checkpoints":    {"main": "unsloth/Qwen3.5-9B-GGUF:Qwen3.5-9B-Q4_K_M.gguf",
                       "mmproj": "mmproj-F16.gguf"},
    "labels":         ["vision", "tool-calling"],
    "recipe":         "llamacpp",
    "recipe_options": {"ctx_size": 32768},
    "size":           5.68,
}

# In-memory fallback list — kept for sync lookups and as the last-resort default.
KNOWN_MODELS: list[dict] = [_MODEL_9B, _MODEL_35B]
KNOWN_MODELS_BY_NAME: dict[str, dict] = {m["model_name"]: m for m in KNOWN_MODELS}

_recipe_catalog: list[dict] | None = None
_recipe_catalog_fetched_at: float = 0.0


def _recipe_from_json(data: dict) -> dict:
    """Normalise a recipe JSON blob into our internal model spec."""
    spec: dict = {
        "model_name":     data["model_name"],
        "labels":         data.get("labels", []),
        "recipe":         data.get("recipe", "llamacpp"),
        "recipe_options": data.get("recipe_options", {}),
        "size":           data.get("size"),
    }
    if "checkpoints" in data:
        spec["checkpoints"] = data["checkpoints"]
    elif "checkpoint" in data:
        spec["checkpoint"] = data["checkpoint"]
    return spec


async def get_recipe_catalog(force: bool = False) -> list[dict]:
    """Return the list of all model specs from the openclaw recipe catalog.

    Results are cached for one hour.  Falls back to the hardcoded KNOWN_MODELS
    list when GitHub is unreachable.
    """
    global _recipe_catalog, _recipe_catalog_fetched_at
    now = time.monotonic()
    if (
        not force
        and _recipe_catalog is not None
        and now - _recipe_catalog_fetched_at < _RECIPE_CACHE_TTL
    ):
        return _recipe_catalog

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            idx_r = await client.get(
                _RECIPE_CATALOG_URL,
                headers={"Accept": "application/vnd.github+json"},
            )
            idx_r.raise_for_status()
            recipe_files = [
                item for item in idx_r.json()
                if item.get("type") == "file"
                and item["name"].endswith(".json")
                and item["name"] != "README.md"
            ]
            responses = await asyncio.gather(
                *[client.get(item["download_url"]) for item in recipe_files],
                return_exceptions=True,
            )
        specs = []
        for resp in responses:
            if isinstance(resp, Exception):
                continue
            if resp.status_code != 200:
                continue
            try:
                specs.append(_recipe_from_json(resp.json()))
            except (KeyError, ValueError, Exception):
                continue
        if specs:
            _recipe_catalog = specs
            _recipe_catalog_fetched_at = now
            logger.info("Fetched %d recipes from GitHub recipe catalog", len(specs))
            return _recipe_catalog
    except Exception as exc:
        logger.warning("Could not fetch recipe catalog from GitHub: %s", exc)

    # Return stale cache if available, otherwise fall back to hardcoded list.
    return _recipe_catalog if _recipe_catalog is not None else KNOWN_MODELS


def _build_pull_payload(spec: dict) -> dict:
    """Build the /api/v1/pull request body from a recipe spec.

    Mirrors recipeToPullPayload() in setup-providers.js — only includes
    fields that lemonade's pull endpoint understands.
    """
    payload: dict = {
        "model_name": spec["model_name"],
        "recipe":     spec.get("recipe", "llamacpp"),
        "stream":     True,
    }
    if "checkpoints" in spec:
        payload["checkpoints"] = spec["checkpoints"]
    elif "checkpoint" in spec:
        payload["checkpoint"] = spec["checkpoint"]
    labels = spec.get("labels", [])
    if "vision" in labels:
        payload["vision"] = True
    if "reasoning" in labels:
        payload["reasoning"] = True
    if "embeddings" in labels:
        payload["embedding"] = True
    if "reranking" in labels:
        payload["reranking"] = True
    return payload


_GiB = 1 << 30

# Path where the user's model preference is persisted across restarts.
_MODEL_OVERRIDE_PATH = Path("/var/lib/nimbus/model_override.json")

_model_override: dict | None = None


def _select_model() -> dict:
    """Pick the 35B model on AMD RYZEN AI devices with ≥64 GB RAM, else 9B."""
    try:
        is_ryzen_ai = False
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("model name") and "RYZEN AI" in line.upper():
                    is_ryzen_ai = True
                    break

        if not is_ryzen_ai:
            return _MODEL_9B

        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    if kb * 1024 >= 48 * _GiB:
                        return _MODEL_35B
                    break
    except OSError:
        pass
    return _MODEL_9B


DEFAULT_MODEL: dict = _select_model()


def get_active_model_spec() -> dict:
    """Return the user-selected model spec if set, otherwise DEFAULT_MODEL.

    The full spec is persisted to disk (including checkpoints and recipe_options)
    so it can be restored on restart without requiring a catalog fetch.
    """
    global _model_override
    if _model_override is None:
        try:
            data = json.loads(_MODEL_OVERRIDE_PATH.read_text())
            if data.get("model_name"):
                _model_override = data
                logger.info("Loaded user model override: %s", data["model_name"])
        except FileNotFoundError:
            pass
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Could not read model override: %s", exc)
    return _model_override if _model_override is not None else DEFAULT_MODEL


def set_model_override(spec: dict) -> None:
    """Persist the full model spec to disk and update the in-memory cache."""
    global _model_override
    _model_override = spec
    try:
        _MODEL_OVERRIDE_PATH.parent.mkdir(parents=True, exist_ok=True)
        _MODEL_OVERRIDE_PATH.write_text(json.dumps(spec, indent=2))
        logger.info("Persisted model override: %s", spec["model_name"])
    except OSError as exc:
        logger.warning("Could not persist model override: %s", exc)


@dataclass
class LemonadeStatus:
    reachable: bool
    base_url: str
    error: Optional[str] = None


@dataclass
class PullState:
    # idle -> checking -> pulling -> loading -> ready
    # idle -> failed | skipped
    status: str = "idle"
    model: str = ""
    percent: float = 0.0
    file_index: int = 0
    total_files: int = 0
    error: Optional[str] = None
    started_at: float = 0.0
    updated_at: float = 0.0


_pull_state: PullState = PullState()


def get_pull_state() -> PullState:
    return _pull_state


def _set_pull_state(**changes) -> None:
    global _pull_state
    for k, v in changes.items():
        setattr(_pull_state, k, v)
    _pull_state.updated_at = time.monotonic()


async def status() -> LemonadeStatus:
    """Quick liveness check — fetches /api/v1/models."""
    url = f"{LEMONADE_BASE_URL}/api/v1/models"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(url)
        if r.status_code == 200:
            return LemonadeStatus(reachable=True, base_url=LEMONADE_BASE_URL)
        return LemonadeStatus(
            reachable=False, base_url=LEMONADE_BASE_URL,
            error=f"HTTP {r.status_code}",
        )
    except httpx.HTTPError as exc:
        return LemonadeStatus(reachable=False, base_url=LEMONADE_BASE_URL, error=str(exc))


async def is_model_installed(model_name: str) -> bool:
    """Check whether a model is already registered + downloaded in Lemonade."""
    url = f"{LEMONADE_BASE_URL}/api/v1/models"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(url)
        if r.status_code != 200:
            return False
        data = r.json()
        models = data.get("data") if isinstance(data, dict) else data
        if not isinstance(models, list):
            return False
        return any(
            isinstance(m, dict) and m.get("id") == model_name
            for m in models
        )
    except httpx.HTTPError:
        return False


async def pull_model(spec: dict) -> None:
    """POST /v1/pull with SSE streaming. Logs progress + updates pull state."""
    url = f"{LEMONADE_BASE_URL}/api/v1/pull"
    body = _build_pull_payload(spec)
    name = spec.get("model_name", "")
    logger.info("Lemonade: pulling model %s", name)
    _set_pull_state(status="pulling", model=name, percent=0.0, error=None)
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("POST", url, json=body) as r:
            if r.status_code != 200:
                detail = await r.aread()
                raise RuntimeError(
                    f"Lemonade /v1/pull HTTP {r.status_code}: {detail.decode(errors='replace')[:300]}"
                )
            last_pct_logged = -1
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload:
                    continue
                try:
                    evt = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if "error" in evt:
                    raise RuntimeError(f"Lemonade pull error: {evt['error']}")
                pct = evt.get("percent")
                fi = evt.get("file_index")
                tf = evt.get("total_files")
                if isinstance(pct, (int, float)):
                    _set_pull_state(
                        percent=float(pct),
                        file_index=int(fi) if isinstance(fi, (int, float)) else _pull_state.file_index,
                        total_files=int(tf) if isinstance(tf, (int, float)) else _pull_state.total_files,
                    )
                    if int(pct) // 5 != last_pct_logged // 5:
                        last_pct_logged = int(pct)
                        logger.info(
                            "Lemonade pull progress: %s%% (file %s/%s)",
                            last_pct_logged, fi, tf,
                        )
    logger.info("Lemonade: pull complete for %s", name)
    _set_pull_state(percent=100.0)


async def load_model(spec: dict) -> None:
    """POST /v1/load — load the model with its recipe options (ctx_size etc).

    Mirrors what setup-providers.js sends: model_name + save_options + all
    recipe_options (e.g. ctx_size) so lemonade uses the correct context window
    rather than its built-in default.
    """
    url = f"{LEMONADE_BASE_URL}/api/v1/load"
    body: dict = {
        "model_name": spec["model_name"],
        "save_options": True,
        **spec.get("recipe_options", {}),
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.post(url, json=body)
    if r.status_code != 200:
        raise RuntimeError(
            f"Lemonade /v1/load HTTP {r.status_code}: {r.text[:300]}"
        )
    logger.info("Lemonade: loaded %s", spec["model_name"])


async def ensure_model(spec: dict) -> None:
    """Pull + load a specific model spec if not already present.

    Designed to be safe to run as a background task at any time. Logs and
    updates pull state on failure rather than raising.
    """
    name = spec["model_name"]
    _set_pull_state(
        status="checking", model=name, percent=0.0,
        file_index=0, total_files=0, error=None,
        started_at=time.monotonic(),
    )

    s = await status()
    if not s.reachable:
        logger.warning(
            "Lemonade not reachable at %s (%s) — skipping model pre-pull. "
            "User can pull manually via 'lemonade pull' once it's running.",
            s.base_url, s.error,
        )
        _set_pull_state(status="skipped", error=f"Lemonade unreachable: {s.error or ''}".strip())
        return

    if await is_model_installed(name):
        logger.info("Lemonade: %s already installed, skipping pull", name)
    else:
        try:
            await pull_model(spec)
        except Exception as exc:
            logger.error("Lemonade pull failed for %s: %s", name, exc)
            _set_pull_state(status="failed", error=str(exc))
            return

    _set_pull_state(status="loading")
    try:
        await load_model(spec)
    except Exception as exc:
        logger.error("Lemonade load failed for %s: %s", name, exc)
        _set_pull_state(status="failed", error=str(exc))
        return

    _set_pull_state(status="ready", percent=100.0)


async def ensure_default_model() -> None:
    """Pull + load the active model (user override or hardware default).

    Delegates to ensure_model() with the currently active model spec.
    """
    await ensure_model(get_active_model_spec())


def ensure_default_model_task() -> asyncio.Task:
    """Fire-and-forget: schedule the pre-pull on the running event loop."""
    return asyncio.create_task(ensure_default_model())


async def wait_until_ready(timeout: float = 1800.0) -> bool:
    """Poll pull state until ready/skipped or timeout (default 30 min).

    Returns True if the model is ready or the pull was skipped (lemonade
    unreachable), False on failure or timeout.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        state = get_pull_state()
        if state.status in ("ready", "skipped"):
            return True
        if state.status == "failed":
            return False
        if asyncio.get_event_loop().time() >= deadline:
            logger.warning("wait_until_ready timed out after %.0fs", timeout)
            return False
        await asyncio.sleep(5)
