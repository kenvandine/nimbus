from __future__ import annotations

import logging
import os
from pathlib import Path

from services.crypto_store import load_encrypted_json, save_encrypted_json

logger = logging.getLogger(__name__)

_STORE_FILE = "api-keys.json"
_SALT_FILE = "apikeys-salt"


def _snap_data() -> Path:
    return Path(os.environ.get("SNAP_DATA", "/var/snap/nimbus/current"))


def _store_path() -> Path:
    return _snap_data() / _STORE_FILE


def _load_store() -> dict[str, str]:
    return load_encrypted_json(_store_path(), _SALT_FILE)


def _save_store(data: dict[str, str]) -> None:
    save_encrypted_json(_store_path(), data, _SALT_FILE)


def list_keys() -> list[dict]:
    store = _load_store()
    return [{"name": name, "hint": f"...{val[-4:]}" if len(val) > 4 else "***"} for name, val in store.items()]


def get_key(name: str) -> str | None:
    return _load_store().get(name)


def set_key(name: str, value: str) -> None:
    store = _load_store()
    store[name] = value
    _save_store(store)
    _inject_into_container(name, value)


def delete_key(name: str) -> None:
    store = _load_store()
    if name not in store:
        raise ValueError(f"Key '{name}' not found")
    del store[name]
    _save_store(store)


def _inject_into_container(name: str, value: str) -> None:
    """Write key as an environment file into the container for app consumption."""
    try:
        from services.lxd import get_lxd_manager
        from config import settings
        if settings.control_mode != "lxd":
            return
        mgr = get_lxd_manager()
        instance = mgr.get_instance()
        env_dir = "/etc/nimbus/env.d"
        mgr.exec_in_container(["mkdir", "-p", env_dir])
        import re
        safe_name = re.sub(r'[^A-Z0-9_]', '_', name.upper())
        if safe_name and safe_name[0].isdigit():
            safe_name = '_' + safe_name
        content = f"export {safe_name}={value!r}\n".encode()
        instance.files.put(f"{env_dir}/{safe_name}.env", content)
    except Exception as exc:
        logger.warning("Failed to inject API key '%s' into container: %s", name, exc)
