from __future__ import annotations

import json
import logging
import re
import secrets
from pathlib import Path
from typing import Optional

from config import settings

logger = logging.getLogger(__name__)

_ALGORITHM = "HS256"
_ACCESS_TOKEN_EXPIRE_HOURS = 24
_REFRESH_TOKEN_EXPIRE_DAYS = 30
_WS_TOKEN_EXPIRE_MINUTES = 5

try:
    from passlib.context import CryptContext
    _pwd_context = CryptContext(
        schemes=["pbkdf2_sha256", "bcrypt"],
        deprecated=["bcrypt"],
    )
except ImportError as _exc:
    raise RuntimeError(
        f"passlib[bcrypt] is required but not available: {_exc}"
    ) from _exc

try:
    from jose import jwt, JWTError as _JWTError
except ImportError as _exc:
    raise RuntimeError(
        f"python-jose[cryptography] is required but not available: {_exc}"
    ) from _exc


def _account_file() -> Path:
    return settings.installed_dir.parent / "admin-account.json"


def _secret_file() -> Path:
    return settings.installed_dir.parent / "auth-secret"


def _refresh_secret_file() -> Path:
    return settings.installed_dir.parent / "auth-refresh-secret"


def _get_or_create_secret() -> str:
    f = _secret_file()
    if f.exists():
        return f.read_text(encoding="utf-8").strip()
    secret = secrets.token_hex(32)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(secret, encoding="utf-8")
    f.chmod(0o600)
    return secret


def _get_or_create_refresh_secret() -> str:
    f = _refresh_secret_file()
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
        data = _read_account_data()
        return str(data.get("username") or "")
    except Exception:
        return None


def _read_account_data() -> dict:
    return json.loads(_account_file().read_text(encoding="utf-8"))


def _write_account_data(data: dict) -> None:
    f = _account_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data), encoding="utf-8")
    f.chmod(0o600)


_PASSWORD_MIN_LEN = 8
_PASSWORD_COMPLEXITY_RE = re.compile(
    r"^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':\"\\|,.<>\/?`~]).{12,}$"
)


def _validate_password_complexity(password: str) -> None:
    """Raise ValueError if password doesn't meet complexity requirements."""
    if len(password) < _PASSWORD_MIN_LEN:
        raise ValueError(f"Password must be at least {_PASSWORD_MIN_LEN} characters")
    if len(password) >= 12 and not _PASSWORD_COMPLEXITY_RE.match(password):
        raise ValueError(
            "Passwords of 12+ characters must contain at least one uppercase letter, "
            "one digit, and one special character"
        )


def create_account(username: str, password: str) -> None:
    if account_exists():
        raise ValueError("An account already exists")
    if not username.strip():
        raise ValueError("Username is required")
    _validate_password_complexity(password)
    data = {
        "username": username.strip(),
        "password_hash": _pwd_context.hash(password),
    }
    _write_account_data(data)


def change_password(username: str, old_password: str, new_password: str) -> None:
    if not verify_credentials(username, old_password):
        raise ValueError("Current password is incorrect")
    _validate_password_complexity(new_password)
    data = _read_account_data()
    data["password_hash"] = _pwd_context.hash(new_password)
    _write_account_data(data)


def verify_credentials(username: str, password: str) -> bool:
    if not account_exists():
        return False
    try:
        data = _read_account_data()
        if data.get("username") != username:
            return False
        verified = bool(_pwd_context.verify(password, data["password_hash"]))
        if verified and _pwd_context.needs_update(data["password_hash"]):
            data["password_hash"] = _pwd_context.hash(password)
            _write_account_data(data)
        return verified
    except Exception:
        return False


def create_session_token(username: str) -> str:
    from datetime import datetime, timedelta, timezone
    payload = {
        "sub": username,
        "type": "access",
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(hours=_ACCESS_TOKEN_EXPIRE_HOURS),
    }
    return jwt.encode(payload, _get_or_create_secret(), algorithm=_ALGORITHM)


def create_refresh_token(username: str) -> str:
    from datetime import datetime, timedelta, timezone
    payload = {
        "sub": username,
        "type": "refresh",
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(days=_REFRESH_TOKEN_EXPIRE_DAYS),
    }
    return jwt.encode(payload, _get_or_create_refresh_secret(), algorithm=_ALGORITHM)


def verify_session_token(token: str) -> Optional[str]:
    """Return the username if the access token is valid, otherwise None."""
    try:
        payload = jwt.decode(token, _get_or_create_secret(), algorithms=[_ALGORITHM])
        if payload.get("type") != "access":
            return None
        return payload.get("sub") or None
    except _JWTError:
        return None


def verify_refresh_token(token: str) -> Optional[str]:
    """Return the username if the refresh token is valid, otherwise None."""
    try:
        payload = jwt.decode(token, _get_or_create_refresh_secret(), algorithms=[_ALGORITHM])
        if payload.get("type") != "refresh":
            return None
        return payload.get("sub") or None
    except _JWTError:
        return None


def create_ws_token(username: str) -> str:
    """Issue a short-lived token dedicated for WebSocket connections."""
    from datetime import datetime, timedelta, timezone
    payload = {
        "sub": username,
        "type": "ws",
        "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc) + timedelta(minutes=_WS_TOKEN_EXPIRE_MINUTES),
    }
    return jwt.encode(payload, _get_or_create_secret(), algorithm=_ALGORITHM)


def verify_ws_token(token: str) -> Optional[str]:
    """Return the username if the WS token is valid, otherwise None."""
    try:
        payload = jwt.decode(token, _get_or_create_secret(), algorithms=[_ALGORITHM])
        if payload.get("type") != "ws":
            return None
        return payload.get("sub") or None
    except _JWTError:
        return None
