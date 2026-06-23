from __future__ import annotations

import base64
import hashlib
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

_KEYS_FILE_NAME = "authorized_keys"


def _snap_data() -> Path:
    return Path(os.environ.get("SNAP_DATA", "/var/snap/nimbus/current"))


def _keys_path() -> Path:
    p = _snap_data() / "ssh"
    p.mkdir(parents=True, exist_ok=True)
    return p / _KEYS_FILE_NAME


def _load_keys() -> list[str]:
    kp = _keys_path()
    if not kp.exists():
        return []
    return [line for line in kp.read_text().splitlines() if line.strip()]


def _save_keys(keys: list[str]) -> None:
    p = _keys_path()
    p.write_text("\n".join(keys) + "\n" if keys else "")
    p.chmod(0o600)


def _fingerprint(pubkey: str) -> str:
    """Return the SHA-256 fingerprint of an SSH public key."""
    parts = pubkey.split()
    if len(parts) < 2:
        raise ValueError("Invalid public key format")
    key_bytes = base64.b64decode(parts[1])
    digest = hashlib.sha256(key_bytes).digest()
    b64 = base64.b64encode(digest).decode().rstrip("=")
    return f"SHA256:{b64}"


def get_ssh_status() -> dict:
    keys = _load_keys()
    return {
        "enabled": True,
        "authorized_key_count": len(keys),
    }


def list_authorized_keys() -> list[dict]:
    keys = _load_keys()
    result = []
    for key in keys:
        parts = key.strip().split()
        try:
            fp = _fingerprint(key)
        except Exception:
            fp = "unknown"
        result.append({
            "fingerprint": fp,
            "type": parts[0] if parts else "unknown",
            "comment": parts[2] if len(parts) > 2 else "",
            "key": key,
        })
    return result


def add_authorized_key(pubkey: str) -> str:
    pubkey = pubkey.strip()
    parts = pubkey.split()
    if len(parts) < 2:
        raise ValueError("Invalid public key format")
    fp = _fingerprint(pubkey)
    keys = _load_keys()
    for existing in keys:
        if _fingerprint(existing) == fp:
            raise ValueError("Key already exists")
    keys.append(pubkey)
    _save_keys(keys)
    _push_keys_to_container()
    return fp


def remove_authorized_key(fingerprint: str) -> None:
    keys = _load_keys()
    original_len = len(keys)
    keys = [k for k in keys if _fingerprint(k) != fingerprint]
    if len(keys) == original_len:
        raise ValueError(f"Key not found: {fingerprint}")
    _save_keys(keys)
    _push_keys_to_container()


def _push_keys_to_container() -> None:
    """Push authorized_keys into the managed container's ubuntu user."""
    try:
        from services.lxd import get_lxd_manager
        from config import settings
        if settings.control_mode != "lxd":
            return
        mgr = get_lxd_manager()
        instance = mgr.get_instance()
        keys_content = _keys_path().read_bytes()
        instance.files.put("/home/ubuntu/.ssh/authorized_keys", keys_content)
        mgr.exec_in_container(
            ["chown", "ubuntu:ubuntu", "/home/ubuntu/.ssh/authorized_keys"]
        )
        mgr.exec_in_container(
            ["chmod", "600", "/home/ubuntu/.ssh/authorized_keys"]
        )
    except Exception as exc:
        logger.warning("Failed to push authorized_keys to container: %s", exc)
