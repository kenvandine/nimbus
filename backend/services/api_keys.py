from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

_STORE_FILE = "api-keys.json"


def _snap_data() -> Path:
    return Path(os.environ.get("SNAP_DATA", "/var/snap/nimbus/current"))


def _auth_secret_path() -> Path:
    from config import settings
    return settings.installed_dir.parent / "auth-secret"


def _store_path() -> Path:
    return _snap_data() / _STORE_FILE


def _fernet():
    try:
        from cryptography.fernet import Fernet
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        import base64

        secret_file = _auth_secret_path()
        if not secret_file.exists():
            raise RuntimeError("Auth secret not found — account not set up yet")
        passphrase = secret_file.read_bytes()
        salt_file = _snap_data() / "apikeys-salt"
        if not salt_file.exists():
            salt = os.urandom(16)
            salt_file.write_bytes(salt)
            salt_file.chmod(0o600)
        else:
            salt = salt_file.read_bytes()
        kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=100_000)
        key = base64.urlsafe_b64encode(kdf.derive(passphrase))
        return Fernet(key)
    except ImportError:
        return None


def _load_store() -> dict[str, str]:
    p = _store_path()
    if not p.exists():
        return {}
    f = _fernet()
    raw = p.read_bytes()
    if f:
        try:
            raw = f.decrypt(raw)
        except Exception:
            logger.warning("api-keys: decryption failed, returning empty store")
            return {}
    return json.loads(raw)


def _save_store(data: dict[str, str]) -> None:
    raw = json.dumps(data).encode()
    f = _fernet()
    if f:
        raw = f.encrypt(raw)
    p = _store_path()
    p.write_bytes(raw)
    p.chmod(0o600)


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
        safe_name = name.upper().replace("-", "_").replace(" ", "_")
        content = f"export {safe_name}={value!r}\n".encode()
        instance.files.put(f"{env_dir}/{safe_name}.env", content)
    except Exception as exc:
        logger.warning("Failed to inject API key '%s' into container: %s", name, exc)
