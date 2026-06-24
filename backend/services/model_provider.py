"""Thin abstraction over the local-LLM backends Nimbus can drive OpenClaw at.

Two providers are supported, selected by NIMBUS_MODEL_PROVIDER:

  * "lemonade-server" (default) — talk to the lemonade-server snap.
  * "inference-snap-gemma4" — talk to the gemma4 snap.

The OpenAI-compatible endpoint OpenClaw is pointed at is set via the
`openai-url` snap setting (NIMBUS_OPENAI_URL), with per-provider defaults
in config.DEFAULT_OPENAI_URL. The openclaw setup wrapper reads
NIMBUS_OPENCLAW_BASE_URL / API_PATH / MODEL_ID / PROVIDER_ID env vars
produced by gateway_environment() and wires them into the onboard flow.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse, urlunparse

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
    # base_url is the full OpenAI-compatible endpoint (with /api/v1) the
    # operator configured via the `openai-url` snap setting; gateway_environment
    # splits it into prefix + path for the openclaw wrapper.
    return ProviderConfig(
        provider_id="lemonade",
        base_url=settings.openai_url,
        model_id=lemonade.get_active_model_spec()["model_name"],
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
    # The nimbus snap can't reach `gemma4 status` under confinement, so we
    # trust the operator-supplied openai-url (or its provider default) rather
    # than trying to discover the port at runtime.
    return ProviderConfig(
        provider_id="gemma4",
        base_url=settings.openai_url,
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


def loopback_listen_port() -> int | None:
    """Return the host TCP port if `openai-url` points at the host's loopback,
    else None. Used by services/lxd.py to decide whether to install an LXD
    proxy device that bridges the openclaw container to a host-bound service.
    """
    try:
        parsed = urlparse(settings.openai_url)
    except ValueError:
        return None
    if parsed.hostname not in ("127.0.0.1", "localhost"):
        return None
    if parsed.port is not None:
        return parsed.port
    if parsed.scheme == "http":
        return 80
    if parsed.scheme == "https":
        return 443
    return None


def get_provider_config() -> ProviderConfig:
    if settings.model_provider == MODEL_PROVIDER_GEMMA4:
        return _gemma4_config()
    return _lemonade_config()


def get_state() -> ProviderState:
    if settings.model_provider == MODEL_PROVIDER_GEMMA4:
        return _gemma4_state()
    return _lemonade_state()


def _container_url(base_url: str) -> str:
    """Rewrite a host-loopback URL to one reachable from inside docker-in-LXC."""
    return base_url.replace("localhost", "host.docker.internal").replace(
        "127.0.0.1", "host.docker.internal"
    )


def gateway_environment() -> dict[str, str]:
    """Env vars to inject into the openclaw gateway container so the setup
    wrapper configures the right backend."""
    cfg = get_provider_config()
    # In LXD mode the gateway runs inside docker-in-LXC and reaches the host
    # via host.docker.internal — rewrite localhost in the base URL to that
    # alias so the openclaw wizard records a URL the container can resolve.
    container_base = _container_url(cfg.base_url)
    # The wrapper concatenates NIMBUS_OPENCLAW_BASE_URL + NIMBUS_OPENCLAW_API_PATH;
    # split the configured full URL so the operator's path (e.g. /v1 vs /api/v1)
    # wins over the wrapper's provider-keyed default.
    parsed = urlparse(container_base)
    prefix = urlunparse((parsed.scheme, parsed.netloc, "", "", "", ""))
    api_path = parsed.path or ""
    return {
        "NIMBUS_OPENCLAW_BASE_URL": prefix,
        "NIMBUS_OPENCLAW_API_PATH": api_path,
        "NIMBUS_OPENCLAW_MODEL_ID": cfg.model_id,
        "NIMBUS_OPENCLAW_PROVIDER_ID": cfg.provider_id,
        "NIMBUS_OPENCLAW_COMPATIBILITY": cfg.compatibility,
        "NIMBUS_MODEL_PROVIDER": settings.model_provider,
    }


def hermes_container_environment() -> dict[str, str]:
    """Env vars to inject into the hermes-agent gateway container so it uses
    the configured local-LLM backend (lemonade or gemma4) via the OpenAI
    compatibility layer.

    Uses the lmstudio provider (openai_chat transport) so hermes routes to
    LM_BASE_URL instead of defaulting to openrouter when OPENAI_API_KEY is set.
    """
    cfg = get_provider_config()
    container_base = _container_url(cfg.base_url)
    return {
        # lmstudio provider env vars — used when auth.json sets active_provider: lmstudio
        "LM_BASE_URL": container_base,
        "LM_API_KEY": "nimbus-local",
        # Keep standard OpenAI vars for any tooling that reads them directly
        "OPENAI_BASE_URL": container_base,
        "OPENAI_API_KEY": "nimbus-local",
        "HERMES_MODEL": cfg.model_id,
    }


def anythingllm_container_environment() -> dict[str, str]:
    """Env vars to inject into the AnythingLLM container to pre-select the
    local-LLM backend as the LLM provider via the generic-openai adapter."""
    cfg = get_provider_config()
    return {
        "LLM_PROVIDER": "generic-openai",
        "GENERIC_OPEN_AI_BASE_PATH": _container_url(cfg.base_url),
        "GENERIC_OPEN_AI_API_KEY": "nimbus-local",
        "GENERIC_OPEN_AI_MODEL_PREF": cfg.model_id,
        "GENERIC_OPEN_AI_MAX_TOKENS": "4096",
    }


def picoclaw_container_environment() -> dict[str, str]:
    """Env vars to inject into the PicoClaw container as a best-effort attempt
    to point it at the local-LLM backend via standard OpenAI SDK env vars."""
    cfg = get_provider_config()
    return {
        "OPENAI_BASE_URL": _container_url(cfg.base_url),
        "OPENAI_API_KEY": "nimbus-local",
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


async def wait_until_ready(timeout: float = 1800.0) -> bool:
    """Block until the active model provider is ready (or timeout/failure).

    Used by the snap onboard flow to ensure the LLM backend has a loaded model
    before running configuration commands (e.g. ``openclaw.lemonade --auto``)
    that probe the backend.
    """
    if settings.model_provider == MODEL_PROVIDER_GEMMA4:
        return await gemma4.wait_until_ready(timeout=timeout)
    return await lemonade.wait_until_ready(timeout=timeout)


def is_ready() -> bool:
    """Return True if the model provider is already in a ready/skipped state."""
    state = get_state()
    return state.status in ("ready", "skipped", "idle")
