from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from auth import SESSION_COOKIE

router = APIRouter(prefix="/api/auth", tags=["auth"])

_COOKIE_MAX_AGE = 7 * 24 * 3600  # 7 days


class AccountSetupRequest(BaseModel):
    username: str
    password: str


class LoginRequest(BaseModel):
    username: str
    password: str


def _set_session(response: Response, username: str) -> None:
    from services.auth import create_session_token
    token = create_session_token(username)
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        max_age=_COOKIE_MAX_AGE,
        httponly=True,
        samesite="strict",
        path="/",
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

    # NIMBUS_API_TOKEN bearer always counts as authenticated.
    if not authenticated and settings.api_token:
        auth_header = request.headers.get("Authorization", "")
        if auth_header == f"Bearer {settings.api_token}":
            authenticated = True
            username = get_username()

    return {
        "configured": configured,
        "authenticated": authenticated,
        "username": username,
    }


@router.post("/setup")
async def setup_account(req: AccountSetupRequest, response: Response) -> dict:
    from services.auth import account_exists, create_account, create_session_token
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
    return {"status": "ok"}
