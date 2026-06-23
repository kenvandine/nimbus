"""AI Labs snap catalog and Snap Store metadata service."""
from __future__ import annotations

import json
import logging
import os
import platform
import time
from pathlib import Path
from typing import Any

import httpx

from models import AppMeta

logger = logging.getLogger(__name__)

_MACHINE_TO_SNAP_ARCH = {
    "x86_64": "amd64",
    "aarch64": "arm64",
    "armv7l": "armhf",
    "armv6l": "armel",
    "ppc64le": "ppc64el",
    "s390x": "s390x",
    "riscv64": "riscv64",
}


def _snap_arch() -> str:
    return _MACHINE_TO_SNAP_ARCH.get(platform.machine(), "amd64")


_SNAPCRAFT_API = "https://api.snapcraft.io/v2/snaps/info"
_CACHE_TTL = 3600  # 1 hour
_metadata_cache: dict[str, tuple[float, dict]] = {}


def _catalog_path() -> Path:
    snap = os.environ.get("SNAP", "")
    if snap:
        return Path(snap) / "setup" / "snap-catalog.json"
    return Path(__file__).resolve().parents[2] / "setup" / "snap-catalog.json"


def load_catalog() -> dict:
    """Load the bundled snap catalog JSON."""
    path = _catalog_path()
    try:
        return json.loads(path.read_text())
    except Exception as exc:
        logger.warning("Could not load snap catalog from %s: %s", path, exc)
        return {"version": 1, "store_id": "ai-labs", "display_name": "AI Labs", "snaps": []}


async def fetch_snap_metadata(name: str) -> dict[str, Any]:
    """Fetch snap metadata from the Snap Store, with 1-hour in-memory cache."""
    now = time.monotonic()
    cached = _metadata_cache.get(name)
    if cached and (now - cached[0]) < _CACHE_TTL:
        return cached[1]

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{_SNAPCRAFT_API}/{name}",
                headers={
                    "Snap-Device-Architecture": _snap_arch(),
                    "Snap-Device-Series": "16",
                    "User-Agent": "nimbus-appliance/1.0",
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        logger.debug("Snap Store metadata fetch failed for %s: %s", name, exc)
        return {}

    snap = data.get("snap", {})
    channel_map = data.get("channel-map", [])
    stable = next(
        (c for c in channel_map if c.get("channel", {}).get("name") == "latest/stable"),
        channel_map[0] if channel_map else {},
    )

    media = snap.get("media", [])
    icon_url = next((m["url"] for m in media if m.get("type") == "icon"), None)
    screenshots = [m["url"] for m in media if m.get("type") == "screenshot"]

    result = {
        "title": snap.get("title", name),
        "summary": snap.get("summary", ""),
        "description": snap.get("description", ""),
        "publisher": snap.get("publisher", {}).get("display-name", ""),
        "website": snap.get("website", ""),
        "license": snap.get("license", ""),
        "icon_url": icon_url,
        "screenshots": screenshots,
        "version": stable.get("version", ""),
        "confinement": stable.get("confinement", ""),
        "categories": [c.get("name", "") for c in snap.get("categories", [])],
    }

    _metadata_cache[name] = (now, result)
    return result


async def get_catalog_with_metadata() -> dict:
    """Return the full catalog, each entry enriched with Snap Store metadata."""
    catalog = load_catalog()
    enriched = []
    for entry in catalog.get("snaps", []):
        name = entry["name"]
        meta = await fetch_snap_metadata(name)
        merged = {**entry, **meta}
        if "description_override" in entry:
            merged["description"] = entry["description_override"]
        merged["name"] = name
        enriched.append(merged)
    return {**catalog, "snaps": enriched}


def get_snap_ports(name: str) -> list[int]:
    """Return the declared web ports for a snap from the catalog."""
    catalog = load_catalog()
    for entry in catalog.get("snaps", []):
        if entry["name"] == name:
            return list(entry.get("ports", []))
    return []


def is_snap_catalog_app(app_id: str) -> bool:
    """Return True if app_id is a snap in the AI Labs catalog."""
    catalog = load_catalog()
    return any(s["name"] == app_id for s in catalog.get("snaps", []))


async def get_catalog_app_metas() -> list[AppMeta]:
    """Return AppMeta objects for every snap in the catalog, enriched with Store data."""
    catalog = load_catalog()
    result: list[AppMeta] = []
    for entry in catalog.get("snaps", []):
        name = entry["name"]
        meta = await fetch_snap_metadata(name)
        categories = meta.get("categories") or ([entry.get("category", "")] if entry.get("category") else [])
        result.append(AppMeta(
            id=name,
            name=meta.get("title") or name,
            tagline=meta.get("summary", ""),
            description=entry.get("description_override") or meta.get("description", ""),
            icon=meta.get("icon_url") or "",
            categories=[c for c in categories if c],
            website=meta.get("website", ""),
            developer=meta.get("publisher", ""),
            version=meta.get("version", ""),
            gallery=meta.get("screenshots", []),
            confinement=meta.get("confinement") or None,
            app_type="snap",
            ports=list(entry.get("ports", [])),
        ))
    return result
