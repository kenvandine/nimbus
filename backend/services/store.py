from __future__ import annotations
import asyncio
import logging
from pathlib import Path
from typing import Optional

import yaml

from models import AppMeta

STORE_DIR = Path("/var/lib/nimbus/store")
REPO_URL = "https://github.com/getumbrel/umbrel-apps"
_GALLERY_CDN = "https://getumbrel.github.io/umbrel-apps-gallery"

logger = logging.getLogger(__name__)

# Fields in umbrel-app.yml that are valid app entries (must have these)
_REQUIRED_FIELDS = {"id", "name"}


async def refresh_store() -> None:
    if (STORE_DIR / ".git").exists():
        logger.info("Updating umbrel-apps repo...")
        proc = await asyncio.create_subprocess_exec(
            "git", "-C", str(STORE_DIR), "pull", "--ff-only",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    else:
        logger.info("Cloning umbrel-apps repo...")
        STORE_DIR.mkdir(parents=True, exist_ok=True)
        proc = await asyncio.create_subprocess_exec(
            "git", "clone", "--depth=1", REPO_URL, str(STORE_DIR),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        logger.error("git failed: %s", stderr.decode())
    else:
        logger.info("Store refreshed: %s", stdout.decode().strip())


_VALUE_MAP = {
    "umbrel": "nimbus",
    "umbrel@umbrel.local": "nimbus@nimbus.local",
    "umbrel.local": "nimbus.local",
}


def _rewrite_username(value: str) -> str:
    return _VALUE_MAP.get(value, value)


def _resolve_gallery(app_id: str, entries: list) -> list[str]:
    urls = []
    for entry in entries:
        s = str(entry).strip()
        if s.startswith("http://") or s.startswith("https://"):
            urls.append(s)
        else:
            filename = s.lstrip("./").removeprefix("gallery/")
            urls.append(f"{_GALLERY_CDN}/{app_id}/{filename}")
    return urls


def _parse_meta(app_id: str, data: dict) -> AppMeta:
    icon = f"{_GALLERY_CDN}/{app_id}/icon.svg"
    return AppMeta(
        id=str(data.get("id", app_id)),
        name=str(data.get("name", app_id)),
        tagline=str(data.get("tagline", "")),
        description=str(data.get("description", "")),
        icon=icon,
        categories=[str(c) for c in data.get("categories", [])],
        port_hint=int(data["port"]) if data.get("port") else None,
        gallery=_resolve_gallery(app_id, data.get("gallery") or []),
        website=str(data.get("website", "")),
        developer=str(data.get("developer", "")),
        version=str(data.get("version", "")),
        default_username=_rewrite_username(str(data.get("defaultUsername", "") or "")),
        default_password=str(data.get("defaultPassword", "") or ""),
        deterministic_password=bool(data.get("deterministicPassword", False)),
    )


def list_apps() -> list[AppMeta]:
    apps: list[AppMeta] = []
    if not STORE_DIR.exists():
        return apps

    for app_dir in sorted(STORE_DIR.iterdir()):
        if not app_dir.is_dir() or app_dir.name.startswith("."):
            continue
        meta_file = app_dir / "umbrel-app.yml"
        if not meta_file.exists():
            continue
        try:
            data = yaml.safe_load(meta_file.read_text())
        except Exception as exc:
            logger.warning("Failed to parse %s: %s", meta_file, exc)
            continue
        if not isinstance(data, dict) or not _REQUIRED_FIELDS.issubset(data):
            continue
        if data.get("disabled"):
            continue

        apps.append(_parse_meta(app_dir.name, data))

    return apps


def get_app_meta(app_id: str) -> Optional[AppMeta]:
    meta_file = STORE_DIR / app_id / "umbrel-app.yml"
    if not meta_file.exists():
        return None
    try:
        data = yaml.safe_load(meta_file.read_text())
        return _parse_meta(app_id, data)
    except Exception as exc:
        logger.warning("Failed to parse meta for %s: %s", app_id, exc)
        return None


def get_app_compose_path(app_id: str) -> Optional[Path]:
    path = STORE_DIR / app_id / "docker-compose.yml"
    return path if path.exists() else None
