"""Nimbus App Store catalog service.

Fetches the catalog from https://github.com/kenvandine/nimbus-app-store and
provides AppMeta objects plus download info for sideloading classic snaps into
the LXD container with --dangerous.
"""
from __future__ import annotations

import logging
import platform
import time
from typing import Any

import httpx

from models import AppMeta

logger = logging.getLogger(__name__)

_CACHE_TTL = 3600  # 1 hour

_catalog: dict | None = None
_catalog_fetched_at: float = 0.0


def _catalog_url() -> str:
    from config import settings
    return getattr(settings, "nimbus_store_url",
                   "https://raw.githubusercontent.com/kenvandine/nimbus-app-store/main/catalog.json")


def _current_arch() -> str:
    m = platform.machine().lower()
    if m in {"x86_64", "amd64"}:
        return "amd64"
    if m in {"aarch64", "arm64"}:
        return "arm64"
    return m


def _snap_to_meta(snap: dict[str, Any]) -> AppMeta:
    links = snap.get("links") or {}
    repo = snap.get("package_repo", "") or ""
    developer = repo.split("/")[0] if "/" in repo else (repo or None)
    return AppMeta(
        id=snap["name"],
        name=snap.get("title", snap["name"]),
        tagline=snap.get("summary", ""),
        description=snap.get("description", ""),
        icon=snap.get("icon_url", ""),
        categories=snap.get("categories", []),
        gallery=snap.get("screenshots", []),
        website=links.get("website"),
        developer=developer,
        version=snap.get("version", ""),
        app_type="snap",
        confinement="classic",
        ports=snap.get("ports", []),
    )


def get_snaps(catalog: dict) -> list[dict]:
    return catalog.get("snaps", [])


def get_snap(catalog: dict, name: str) -> dict | None:
    return next((s for s in get_snaps(catalog) if s["name"] == name), None)


def get_download_url(snap: dict, arch: str | None = None) -> str | None:
    arch = arch or _current_arch()
    releases = snap.get("releases", {})
    rel = releases.get(arch) or releases.get("amd64")
    return rel["download_url"] if rel else None


def get_filename(snap: dict, arch: str | None = None) -> str | None:
    arch = arch or _current_arch()
    releases = snap.get("releases", {})
    rel = releases.get(arch) or releases.get("amd64")
    return rel["filename"] if rel else None


def get_install_flags(snap: dict) -> list[str]:
    return list(snap.get("install_flags", ["--classic", "--dangerous"]))


def get_service_name(snap: dict) -> str | None:
    """Return the systemd user service name, or None if the snap has no daemon."""
    return snap.get("service_name") or None


def get_onboard_cmd(snap: dict) -> tuple[str, list[str]] | None:
    """Return (cmd, args) for the post-install onboard command, or None."""
    raw = (snap.get("onboard_cmd") or "").strip()
    if not raw:
        return None
    parts = raw.split()
    return parts[0], parts[1:]


def is_nimbus_store_app(name: str) -> bool:
    """Sync check using the in-memory cached catalog. Returns False if not yet fetched."""
    return _catalog is not None and any(s["name"] == name for s in get_snaps(_catalog))


async def get_catalog(force: bool = False) -> dict:
    global _catalog, _catalog_fetched_at
    now = time.monotonic()
    if not force and _catalog is not None and now - _catalog_fetched_at < _CACHE_TTL:
        return _catalog
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(_catalog_url())
            resp.raise_for_status()
            _catalog = resp.json()
            _catalog_fetched_at = now
            logger.info(
                "Fetched nimbus-app-store catalog: %d apps",
                len(get_snaps(_catalog)),
            )
    except Exception as exc:
        if _catalog is not None:
            logger.warning("Could not refresh nimbus-app-store catalog: %s", exc)
        else:
            logger.error("Could not load nimbus-app-store catalog: %s", exc)
            _catalog = {"snaps": []}
    return _catalog or {"snaps": []}


async def get_app_metas() -> list[AppMeta]:
    catalog = await get_catalog()
    return [_snap_to_meta(s) for s in get_snaps(catalog)]
