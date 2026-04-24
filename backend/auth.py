from __future__ import annotations

import secrets

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from config import settings

_bearer = HTTPBearer(auto_error=False)

SESSION_COOKIE = "nimbus-session"


async def require_api_token(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    from services.auth import account_exists, verify_session_token

    # No account configured yet — OOBE mode, allow everything.
    if not account_exists():
        return

    # Legacy NIMBUS_API_TOKEN bearer override for programmatic/CLI access.
    if settings.api_token and credentials is not None:
        if credentials.scheme.lower() == "bearer" and secrets.compare_digest(
            credentials.credentials, settings.api_token
        ):
            return

    # Session cookie issued by the login endpoint.
    token = request.cookies.get(SESSION_COOKIE)
    if token and verify_session_token(token):
        return

    raise HTTPException(status_code=401, detail="Authentication required")
