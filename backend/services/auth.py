from __future__ import annotations

import json
import logging
import secrets
from pathlib import Path
from typing import Optional

from config import settings

logger = logging.getLogger(__name__)

_ALGORITHM = "HS256"
_TOKEN_EXPIRE_DAYS = 7

try:
    from passlib.context import CryptContext
    _pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
except ImportError as _exc:
    _pwd_context = None
    logger.warning("passlib not available — password hashing disabled: %s", _exc)

try:
    from jose import jwt, JWTError as _JWTError
except ImportError as _exc:
    jwt = None
    _JWTError = Exception
    logger.warning("python-jose not available — session tokens disabled: %s", _exc)


def _account_file() -> Path:
    return settings.installed_dir.parent / "admin-account.json"


def _secret_file() -> Path:
    return settings.installed_dir.parent / "auth-secret"


def _get_or_create_secret() -> str:
    f = _secret_file()
    if f.exists():
        return f.read_text(encoding="utf-8").strip()
    secret = secrets.token_hex(32)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(secret, encoding="utf-8")
    f.chmod(0o600)
    return secret


def account_exists() -> bool:
    return _account_file().exists()


def get_username() -> Optional[str]:
    try:
        data = json.loads(_account_file().read_text(encoding="utf-8"))
        return str(data.get("username") or "")
    except Exception:
        return None


def create_account(username: str, password: str) -> None:
    if _pwd_context is None:
        raise RuntimeError("passlib is required for account creation")
    if account_exists():
        raise ValueError("An account already exists")
    if not username.strip():
        raise ValueError("Username is required")
    if len(password) < 8:
        raise ValueError("Password must be at least 8 characters")
    data = {
        "username": username.strip(),
        "password_hash": _pwd_context.hash(password),
    }
    f = _account_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data), encoding="utf-8")
    f.chmod(0o600)


def verify_credentials(username: str, password: str) -> bool:
    if _pwd_context is None or not account_exists():
        return False
    try:
        data = json.loads(_account_file().read_text(encoding="utf-8"))
        if data.get("username") != username:
            return False
        return bool(_pwd_context.verify(password, data["password_hash"]))
    except Exception:
        return False


def create_session_token(username: str) -> str:
    if jwt is None:
        raise RuntimeError("python-jose is required for session tokens")
    from datetime import datetime, timedelta, timezone
    payload = {
        "sub": username,
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(days=_TOKEN_EXPIRE_DAYS),
    }
    return jwt.encode(payload, _get_or_create_secret(), algorithm=_ALGORITHM)


def verify_session_token(token: str) -> Optional[str]:
    """Return the username if the token is valid, otherwise None."""
    if jwt is None:
        return None
    try:
        payload = jwt.decode(token, _get_or_create_secret(), algorithms=[_ALGORITHM])
        return payload.get("sub") or None
    except _JWTError:
        return None
