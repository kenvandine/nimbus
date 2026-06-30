from __future__ import annotations

import asyncio
import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, RedirectResponse

from auth import require_api_token
from services import tailscale as tailscale_service

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/tailscale",
    tags=["tailscale"],
    dependencies=[Depends(require_api_token)],
)

_TAILSCALE_WEB_BASE = "http://127.0.0.1:8088"

# Headers that must not be forwarded to the upstream service
_HOP_HEADERS = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
})


@router.get("/status")
async def tailscale_status() -> dict:
    return await asyncio.to_thread(tailscale_service.get_status)


@router.get("/webclient", include_in_schema=False)
async def tailscale_webclient_redirect():
    """Redirect bare /webclient to /webclient/ so relative asset URLs resolve."""
    return RedirectResponse(url="/api/tailscale/webclient/")


@router.api_route(
    "/webclient/{path:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    include_in_schema=False,
)
async def tailscale_webclient_proxy(request: Request, path: str = "") -> Response:
    """Reverse-proxy the tailscale web client (running on 127.0.0.1:8088)."""
    target = f"{_TAILSCALE_WEB_BASE}/{path}"
    if request.url.query:
        target += f"?{request.url.query}"

    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in _HOP_HEADERS and k.lower() != "host"
    }
    body = await request.body()

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            upstream = await client.request(
                method=request.method,
                url=target,
                headers=headers,
                content=body,
                follow_redirects=False,
            )
    except httpx.ConnectError:
        raise HTTPException(
            status_code=503,
            detail="Tailscale web service is not running. It starts automatically after tailscale is installed.",
        )

    resp_headers = {
        k: v for k, v in upstream.headers.items()
        if k.lower() not in _HOP_HEADERS
    }
    # httpx decompresses for us; drop the encoding header so the client doesn't try again
    resp_headers.pop("content-encoding", None)

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=resp_headers,
        media_type=upstream.headers.get("content-type"),
    )
