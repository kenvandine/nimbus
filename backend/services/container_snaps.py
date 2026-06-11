"""Host-side client for snap management inside the LXD container agent."""
from __future__ import annotations

import logging
from typing import Any

import httpx

from config import settings

logger = logging.getLogger(__name__)


def _agent_url(path: str) -> str:
    return f"http://{settings.lxd_agent_bind_host}:{settings.lxd_agent_port}{path}"


async def list_container_snaps() -> list[dict[str, Any]]:
    """Return all snaps installed in the LXD container."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(_agent_url("/snaps"))
            resp.raise_for_status()
            return resp.json().get("snaps", [])
    except Exception as exc:
        logger.warning("Could not list container snaps: %s", exc)
        return []


async def get_container_snap(name: str) -> dict[str, Any] | None:
    """Return info for a specific snap in the container, or None if not installed."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(_agent_url(f"/snaps/{name}"))
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json()
    except Exception as exc:
        logger.warning("Could not get container snap %s: %s", name, exc)
        return None


async def install_container_snap(name: str, channel: str = "stable") -> dict[str, Any]:
    """Install a snap in the LXD container. Returns agent result dict."""
    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(
            _agent_url("/snaps/install"),
            json={"name": name, "channel": channel},
        )
        resp.raise_for_status()
        return resp.json()


async def remove_container_snap(name: str) -> dict[str, Any]:
    """Remove a snap from the LXD container."""
    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.post(
            _agent_url("/snaps/remove"),
            json={"name": name},
        )
        resp.raise_for_status()
        return resp.json()


async def refresh_container_snap(name: str, channel: str | None = None) -> dict[str, Any]:
    """Refresh a snap in the LXD container."""
    payload: dict[str, Any] = {"name": name}
    if channel:
        payload["channel"] = channel
    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(
            _agent_url("/snaps/refresh"),
            json=payload,
        )
        resp.raise_for_status()
        return resp.json()
