"""Client for the gemma4 inference snap.

When NIMBUS_MODEL_PROVIDER=inference-snap-gemma4, Nimbus drives OpenClaw against
the gemma4 host snap instead of lemonade-server. The gemma4 snap is assumed to
be preseeded in the appliance image; this module only:

  * Discovers the chat-API port the snap is bound to. The user-facing source
    of truth is `gemma4 status`; this module tries to invoke it directly, but
    in confinement that may fail, so we also support an env override and a
    JSON status file written by the snap.
  * Exposes a status() shape compatible with the lemonade module so the
    openclaw router can render either backend.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Snap publishes status / port info to its writable common area; the file
# format is `{"port": <int>, ...}` if present.
GEMMA4_STATUS_FILE = Path(
    os.getenv("NIMBUS_GEMMA4_STATUS_FILE", "/var/snap/gemma4/common/status.json")
)
# Override used in dev or to point at a remote gemma4 instance. When set, no
# discovery is attempted.
GEMMA4_BASE_URL_OVERRIDE = os.getenv("NIMBUS_GEMMA4_BASE_URL")
# Reasonable default the wizard falls back to if discovery fails. The user
# can correct it via NIMBUS_GEMMA4_BASE_URL after first boot.
GEMMA4_DEFAULT_PORT = int(os.getenv("NIMBUS_GEMMA4_DEFAULT_PORT", "8080"))
# Default model id served by gemma4. Overridable so the openclaw config can
# follow a future model rename without a code change. The snap derives this
# from the loaded model component name (`model-<variant>-<quant>-gguf` →
# `gemma4-<variant>-<quant>`), so the default has to match whichever
# component the model assertion seeds — currently model-e2b-q4-k-m-gguf.
GEMMA4_MODEL_ID = os.getenv("NIMBUS_GEMMA4_MODEL_ID", "gemma4-e2b-q4-k-m")


@dataclass
class Gemma4Status:
    reachable: bool
    base_url: str
    port: int | None = None
    error: Optional[str] = None


@dataclass
class SetupState:
    # idle -> waiting -> ready | failed
    status: str = "idle"
    error: Optional[str] = None
    started_at: float = 0.0
    updated_at: float = 0.0


_setup_state: SetupState = SetupState()


def get_setup_state() -> SetupState:
    return _setup_state


def _set_state(**changes) -> None:
    for k, v in changes.items():
        setattr(_setup_state, k, v)
    _setup_state.updated_at = time.monotonic()


# ---------------------------------------------------------------------------
# Port discovery
# ---------------------------------------------------------------------------

_PORT_RE = re.compile(r"(?:port|listening on)[^0-9]{0,8}(\d{2,5})", re.IGNORECASE)


def _port_from_status_file() -> int | None:
    try:
        data = json.loads(GEMMA4_STATUS_FILE.read_text())
    except (OSError, ValueError):
        return None
    port = data.get("port") if isinstance(data, dict) else None
    return int(port) if isinstance(port, (int, str)) and str(port).isdigit() else None


def _port_from_status_cmd() -> int | None:
    """Best-effort `gemma4 status --format json` invocation. Will typically
    fail in strict confinement; the caller falls through to other discovery
    methods."""
    try:
        proc = subprocess.run(
            ["gemma4", "status", "--format", "json"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, PermissionError):
        return None
    try:
        obj = json.loads(proc.stdout or "")
    except json.JSONDecodeError:
        # Fall back to scraping the textual output for a port number.
        output = (proc.stdout or "") + "\n" + (proc.stderr or "")
        m = _PORT_RE.search(output)
        return int(m.group(1)) if m else None
    endpoints = obj.get("endpoints") if isinstance(obj, dict) else None
    openai_url = endpoints.get("openai") if isinstance(endpoints, dict) else None
    if isinstance(openai_url, str):
        from urllib.parse import urlparse
        try:
            port = urlparse(openai_url).port
        except ValueError:
            port = None
        if port:
            return int(port)
    # Older shape: top-level "port" field.
    port = obj.get("port") if isinstance(obj, dict) else None
    return int(port) if isinstance(port, (int, str)) and str(port).isdigit() else None


def discover_port() -> int | None:
    if GEMMA4_BASE_URL_OVERRIDE:
        return None
    port = _port_from_status_file()
    if port:
        return port
    port = _port_from_status_cmd()
    if port:
        return port
    return None


def base_url() -> str:
    """Return the URL for gemma4's chat API root (no trailing slash).

    Strict-confinement runs (the nimbus snap) can't shell out to
    `gemma4 status`, so the operator-supplied openai-url setting wins over
    discovery. The discovery + default-port path still helps unconfined dev
    runs that haven't set NIMBUS_OPENAI_URL.
    """
    if GEMMA4_BASE_URL_OVERRIDE:
        return GEMMA4_BASE_URL_OVERRIDE.rstrip("/")
    try:
        from config import settings
        configured = (settings.openai_url or "").rstrip("/")
        if configured:
            # Strip a trailing /v1 or /api/v1 so this returns just the server
            # root, matching the contract older callers expect.
            for suffix in ("/api/v1", "/v1"):
                if configured.endswith(suffix):
                    return configured[: -len(suffix)]
            return configured
    except Exception:
        pass
    port = discover_port() or GEMMA4_DEFAULT_PORT
    return f"http://localhost:{port}"


# ---------------------------------------------------------------------------
# Reachability
# ---------------------------------------------------------------------------

async def status() -> Gemma4Status:
    url = base_url()
    port = None
    try:
        from urllib.parse import urlparse
        port = urlparse(url).port
    except Exception:
        port = None
    # Probe a few common readiness paths so this works against both
    # OpenAI-compatible and minimal servers.
    for path in ("/v1/models", "/api/v1/models", "/health", "/"):
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                r = await client.get(url + path)
            if r.status_code < 500:
                return Gemma4Status(reachable=True, base_url=url, port=port)
        except httpx.HTTPError:
            continue
    return Gemma4Status(
        reachable=False, base_url=url, port=port,
        error=f"No response from gemma4 at {url}",
    )


async def wait_until_ready(timeout: float = 120.0) -> bool:
    """Poll gemma4 until it's responsive or timeout elapses. Returns whether
    we observed it ready."""
    _set_state(status="waiting", error=None, started_at=time.monotonic())
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        s = await status()
        if s.reachable:
            _set_state(status="ready")
            return True
        await asyncio.sleep(3.0)
    logger.warning("gemma4 did not become reachable within %ss", timeout)
    _set_state(status="failed", error="gemma4 did not become reachable in time")
    return False


def wait_until_ready_task() -> asyncio.Task:
    return asyncio.create_task(wait_until_ready())
