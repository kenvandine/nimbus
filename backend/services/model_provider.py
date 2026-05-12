"""Thin abstraction over the local-LLM backends Nimbus can drive OpenClaw at.

Two providers are supported, selected by NIMBUS_MODEL_PROVIDER:

  * "lemonade-server" (default) — talk to the lemonade-server snap on
    http://localhost:13305, model preloaded by services/lemonade.py.
  * "inference-snap-gemma4" — talk to the gemma4 snap on a dynamic port
    discovered by services/gemma4.py.

The openclaw setup wrapper reads NIMBUS_OPENCLAW_BASE_URL / MODEL_ID /
PROVIDER_ID env vars produced by gateway_environment() and wires them into
the openclaw onboard flow.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional

from config import MODEL_PROVIDER_GEMMA4, MODEL_PROVIDER_LEMONADE, settings
from services import gemma4, lemonade

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ProviderConfig:
    """Everything the openclaw wrapper needs to talk to the chosen backend."""
    provider_id: str            # value used in openclaw.json (e.g. "lemonade")
    base_url: str               # OpenAI-compatible API base, no trailing slash
    model_id: str
    compatibility: str = "openai"


@dataclass
class ProviderState:
    """Compatibility-shaped state for the openclaw status endpoint."""
    provider: str
    status: str = "idle"        # idle | checking | pulling | loading | waiting | ready | failed | skipped
    model: str = ""
    percent: float = 0.0
    file_index: int = 0
    total_files: int = 0
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Lemonade adapter
# ---------------------------------------------------------------------------

def _lemonade_config() -> ProviderConfig:
    # Lemonade expects its OpenAI-compatible endpoint under /api/v1.
    # base_url here is the *prefix* the openclaw wrapper hands to onboard;
    # the wrapper appends /api/v1 itself when shaping the wizard args.
    return ProviderConfig(
        provider_id="lemonade",
        base_url=lemonade.LEMONADE_BASE_URL.rstrip("/"),
        model_id=lemonade.DEFAULT_MODEL["model_name"],
    )


def _lemonade_state() -> ProviderState:
    p = lemonade.get_pull_state()
    return ProviderState(
        provider=MODEL_PROVIDER_LEMONADE,
        status=p.status,
        model=p.model,
        percent=p.percent,
        file_index=p.file_index,
        total_files=p.total_files,
        error=p.error,
    )


# ---------------------------------------------------------------------------
# Gemma4 adapter
# ---------------------------------------------------------------------------

def _gemma4_config() -> ProviderConfig:
    return ProviderConfig(
        provider_id="gemma4",
        base_url=gemma4.base_url(),
        model_id=gemma4.GEMMA4_MODEL_ID,
    )


def _gemma4_state() -> ProviderState:
    s = gemma4.get_setup_state()
    return ProviderState(
        provider=MODEL_PROVIDER_GEMMA4,
        status=s.status,
        model=gemma4.GEMMA4_MODEL_ID,
        error=s.error,
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def current_provider() -> str:
    return settings.model_provider


def get_provider_config() -> ProviderConfig:
    if settings.model_provider == MODEL_PROVIDER_GEMMA4:
        return _gemma4_config()
    return _lemonade_config()


def get_state() -> ProviderState:
    if settings.model_provider == MODEL_PROVIDER_GEMMA4:
        return _gemma4_state()
    return _lemonade_state()


def gateway_environment() -> dict[str, str]:
    """Env vars to inject into the openclaw gateway container so the setup
    wrapper configures the right backend."""
    cfg = get_provider_config()
    # In LXD mode the gateway runs inside docker-in-LXC and reaches the host
    # via host.docker.internal — rewrite localhost in the base URL to that
    # alias so the openclaw wizard records a URL the container can resolve.
    container_base = cfg.base_url.replace("localhost", "host.docker.internal")
    container_base = container_base.replace("127.0.0.1", "host.docker.internal")
    return {
        "NIMBUS_OPENCLAW_BASE_URL": container_base,
        "NIMBUS_OPENCLAW_MODEL_ID": cfg.model_id,
        "NIMBUS_OPENCLAW_PROVIDER_ID": cfg.provider_id,
        "NIMBUS_OPENCLAW_COMPATIBILITY": cfg.compatibility,
        "NIMBUS_MODEL_PROVIDER": settings.model_provider,
    }


def ensure_ready_task() -> asyncio.Task | None:
    """Fire-and-forget background prep for the selected provider.

    Called when openclaw is being installed (or already installed at boot).
    Lemonade pulls + loads the default model; gemma4 just waits for the snap
    to be reachable. Both return quickly if the provider is already ready.
    """
    if settings.model_provider == MODEL_PROVIDER_GEMMA4:
        return gemma4.wait_until_ready_task()
    return lemonade.ensure_default_model_task()
