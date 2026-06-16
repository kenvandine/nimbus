"""Client for the Lemonade Server REST API (https://lemonade-server.ai).

Lemonade runs as a host snap on http://localhost:13305 and serves models with
an OpenAI-compatible API. Nimbus uses it as the local-LLM backend behind
OpenClaw — when the user installs OpenClaw, we pre-pull and load the default
Qwen3.5 model so the wizard's preselected provider has something to talk to.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

LEMONADE_BASE_URL = os.getenv("NIMBUS_LEMONADE_BASE_URL", "http://localhost:13305")

# Model specs mirrored from kenvandine/recipes (branch openclaw_recipes).
# The 35B MoE is used on AMD RYZEN AI devices with ≥64 GB RAM; everything else
# gets the 9B.
_MODEL_35B = {
    "model_name":     "user.Qwen3.6-35B-A3B-MTP-GGUF",
    "checkpoint":     "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf",
    "mmproj":         "mmproj-F16.gguf",
    "labels":         ["vision", "tool-calling", "mtp"],
    "recipe":         "llamacpp",
    "recipe_options": {"ctx_size": 32768},
}

_MODEL_9B = {
    "model_name":     "user.Qwen3.5-9B-GGUF",
    "checkpoint":     "unsloth/Qwen3.5-9B-GGUF:Qwen3.5-9B-UD-Q4_K_XL.gguf",
    "mmproj":         "mmproj-F16.gguf",
    "labels":         ["vision", "tool-calling"],
    "recipe":         "llamacpp",
    "recipe_options": {"ctx_size": 32768},
}

_GiB = 1 << 30


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
    body = {**spec, "stream": True}
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


async def load_model(model_name: str) -> None:
    """POST /v1/load — explicitly load the model into memory."""
    url = f"{LEMONADE_BASE_URL}/api/v1/load"
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.post(url, json={"model_name": model_name})
    if r.status_code != 200:
        raise RuntimeError(
            f"Lemonade /v1/load HTTP {r.status_code}: {r.text[:300]}"
        )
    logger.info("Lemonade: loaded %s", model_name)


async def ensure_default_model() -> None:
    """Pull + load the OpenClaw default model if not already present.

    Designed to be safe to run as a background task at any time. Logs and
    updates pull state on failure rather than raising — callers (the OpenClaw
    install flow) shouldn't be blocked by Lemonade being slow or unavailable.
    """
    name = DEFAULT_MODEL["model_name"]
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
            await pull_model(DEFAULT_MODEL)
        except Exception as exc:
            logger.error("Lemonade pull failed for %s: %s", name, exc)
            _set_pull_state(status="failed", error=str(exc))
            return

    _set_pull_state(status="loading")
    try:
        await load_model(name)
    except Exception as exc:
        logger.error("Lemonade load failed for %s: %s", name, exc)
        _set_pull_state(status="failed", error=str(exc))
        return

    _set_pull_state(status="ready", percent=100.0)


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
