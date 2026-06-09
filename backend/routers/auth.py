from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from auth import SESSION_COOKIE, require_api_token

router = APIRouter(prefix="/api/auth", tags=["auth"])

_ACCESS_COOKIE_MAX_AGE = 24 * 3600       # 24 hours
_REFRESH_COOKIE_MAX_AGE = 30 * 24 * 3600 # 30 days
_REFRESH_COOKIE = "nimbus-refresh"


class AccountSetupRequest(BaseModel):
    username: str
    password: str


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


def _set_session(response: Response, username: str) -> None:
    from services.auth import create_session_token, create_refresh_token
    access_token = create_session_token(username)
    refresh_token = create_refresh_token(username)
    response.set_cookie(
        key=SESSION_COOKIE,
        value=access_token,
        max_age=_ACCESS_COOKIE_MAX_AGE,
        httponly=True,
        samesite="strict",
        path="/",
    )
    response.set_cookie(
        key=_REFRESH_COOKIE,
        value=refresh_token,
        max_age=_REFRESH_COOKIE_MAX_AGE,
        httponly=True,
        samesite="strict",
        path="/api/auth/refresh",
    )


@router.get("/status")
async def auth_status(request: Request) -> dict:
    from services.auth import account_exists, verify_session_token, get_username
    from config import settings

    configured = account_exists()
    authenticated = False
    username = None

    token = request.cookies.get(SESSION_COOKIE)
    if token:
        u = verify_session_token(token)
        if u:
            authenticated = True
            username = u

    if not authenticated and settings.api_token:
        auth_header = request.headers.get("Authorization", "")
        if auth_header == f"Bearer {settings.api_token}":
            authenticated = True
            username = get_username()

    # Return the session token in the response body so the frontend can pass it
    # to the WebSocket terminal endpoint (cookies don't attach to WS in strict mode).
    return {
        "configured": configured,
        "authenticated": authenticated,
        "username": username,
        "token": token if authenticated and token else None,
    }


@router.post("/setup")
async def setup_account(req: AccountSetupRequest, response: Response) -> dict:
    from services.auth import account_exists, create_account
    if account_exists():
        raise HTTPException(status_code=409, detail="An account is already configured")
    try:
        create_account(req.username, req.password)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    _set_session(response, req.username.strip())
    return {"status": "ok", "username": req.username.strip()}


@router.post("/login")
async def login(req: LoginRequest, response: Response) -> dict:
    from services.auth import verify_credentials
    if not verify_credentials(req.username, req.password):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    _set_session(response, req.username)
    return {"status": "ok", "username": req.username}


@router.post("/logout")
async def logout(response: Response) -> dict:
    response.delete_cookie(key=SESSION_COOKIE, path="/")
    response.delete_cookie(key=_REFRESH_COOKIE, path="/api/auth/refresh")
    return {"status": "ok"}


@router.post("/refresh")
async def refresh_token(request: Request, response: Response) -> dict:
    from services.auth import verify_refresh_token
    token = request.cookies.get(_REFRESH_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="No refresh token")
    username = verify_refresh_token(token)
    if not username:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
    _set_session(response, username)
    return {"status": "ok", "username": username}


@router.post("/change-password")
async def change_password(
    req: ChangePasswordRequest,
    request: Request,
    response: Response,
    _: None = Depends(require_api_token),
) -> dict:
    from services.auth import change_password as svc_change_password, get_username
    username = get_username()
    if not username:
        raise HTTPException(status_code=404, detail="No account configured")
    try:
        svc_change_password(username, req.current_password, req.new_password)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    _set_session(response, username)
    return {"status": "ok"}
