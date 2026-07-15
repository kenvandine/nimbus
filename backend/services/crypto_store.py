"""Shared Fernet-encrypted-at-rest JSON store helpers.

Used by any service that persists secrets to disk (api_keys.py, model_router.py).
The encryption key is derived via PBKDF2 from the account's auth-secret
passphrase plus a per-store salt file, so secrets are unreadable without the
device having been through account setup.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)


def _snap_data() -> Path:
    return Path(os.environ.get("SNAP_DATA", "/var/snap/nimbus/current"))


def get_fernet(salt_filename: str):
    """Derive a Fernet instance from the auth-secret passphrase + a persisted salt.

    Returns None if the `cryptography` package isn't available, in which case
    callers fall back to storing plaintext. Raises if the auth secret doesn't
    exist yet (account not set up) — callers that want a softer failure mode
    should check that precondition themselves.
    """
    try:
        from cryptography.fernet import Fernet
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        import base64

        from config import settings
        secret_file = settings.installed_dir.parent / "auth-secret"
        if not secret_file.exists():
            raise RuntimeError("Auth secret not found — account not set up yet")
        passphrase = secret_file.read_bytes()
        salt_file = _snap_data() / salt_filename
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


def load_encrypted_json(path: Path, salt_filename: str) -> dict:
    if not path.exists():
        return {}
    f = get_fernet(salt_filename)
    raw = path.read_bytes()
    if f:
        try:
            raw = f.decrypt(raw)
        except Exception:
            logger.warning("%s: decryption failed, returning empty store", path.name)
            return {}
    return json.loads(raw)


def save_encrypted_json(path: Path, data: dict, salt_filename: str) -> None:
    raw = json.dumps(data).encode()
    f = get_fernet(salt_filename)
    if f:
        raw = f.encrypt(raw)
    path.write_bytes(raw)
    path.chmod(0o600)
