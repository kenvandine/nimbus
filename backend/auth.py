from __future__ import annotations

import secrets

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from config import settings

_bearer = HTTPBearer(auto_error=False)

SESSION_COOKIE = "nimbus-session"

# See main.TRUSTED_LOCAL_HEADER: the plain-HTTP relay strips this header from
# every request and re-adds it only when the request's real, unspoofable TCP
# peer (before the relay re-originates the connection to the HTTPS backend)
# was loopback. Combined with the request.client.host check below — which for
# a request that skipped the relay entirely (a direct hit on the HTTPS port)
# reflects the true remote peer and can't be forged as loopback over a real
# network — a remote client can satisfy at most one of the two checks, never
# both, so this cannot be used to bypass auth from off-device.
_TRUSTED_LOCAL_HEADER = "x-nimbus-local"
_TRUSTED_LOCAL_HOSTS = frozenset({"127.0.0.1", "::1"})


def _is_trusted_local(request: Request) -> bool:
    return (
        request.client is not None
        and request.client.host in _TRUSTED_LOCAL_HOSTS
        and request.headers.get(_TRUSTED_LOCAL_HEADER) == "1"
    )


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


async def require_api_token_or_local(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> None:
    """Like require_api_token, but also allows genuinely local (kiosk) callers.

    The kiosk display never has a session — its Chromium profile has no login
    UI, so it can't sign in the way a remote browser does. Once an account
    exists, require_api_token would otherwise 401 it forever, leaving the
    on-screen setup/QR display stuck spinning. Only apply this to endpoints
    that are safe for the physically-attached display to read/trigger without
    a session.
    """
    if _is_trusted_local(request):
        return
    await require_api_token(request, credentials)
