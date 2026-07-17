from __future__ import annotations
import asyncio
import logging
import os
import warnings
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import settings
from routers.apps import router as apps_router
from routers.auth import router as auth_router
from routers.files import router as files_router
from routers.network import router as network_router
from routers.openclaw import router as openclaw_router
from routers.snap_store import router as snap_store_router
from routers.system import router as system_router
from routers.terminal import router as terminal_router
from routers.snapshots import router as snapshots_router
from routers.firewall import router as firewall_router
from routers.models import router as models_router
from routers.keys import router as keys_router
from routers.model_router import router as model_router_router
from routers.tailscale import router as tailscale_router
from services.control_plane import get_control_plane
from services import openclaw as openclaw_service
from services.store import ensure_store, refresh_store


def _patch_ws4py_shutdown_race() -> None:
    try:
        from ws4py.manager import EPollPoller
    except Exception:
        return

    if getattr(EPollPoller, "_nimbus_patched", False):
        return

    original_unregister = EPollPoller.unregister
    original_poll = EPollPoller.poll
    original_release = EPollPoller.release

    def safe_unregister(self, fd):
        try:
            return original_unregister(self, fd)
        except (IOError, ValueError):
            return None

    def safe_poll(self):
        try:
            return original_poll(self)
        except (IOError, ValueError):
            return []

    def safe_release(self):
        try:
            return original_release(self)
        except (IOError, ValueError):
            return None

    EPollPoller.unregister = safe_unregister
    EPollPoller.poll = safe_poll
    EPollPoller.release = safe_release
    EPollPoller._nimbus_patched = True


_patch_ws4py_shutdown_race()
warnings.filterwarnings("ignore", "Attempted to set unknown attribute", UserWarning, "pylxd")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("ws4py").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

# Mirror all log output to $SNAP_COMMON/nimbus.log so the journal endpoint can
# tail it without needing the system-observe plug.
_snap_common = os.environ.get("SNAP_COMMON", "")
if _snap_common:
    _log_file = Path(_snap_common) / "nimbus.log"
    _fh = RotatingFileHandler(_log_file, maxBytes=10 * 1024 * 1024, backupCount=2)
    _fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.getLogger().addHandler(_fh)

STATIC_DIR = Path(__file__).parent / "static"


def _seed_theme_override_dir(directory: Path) -> None:
    """Create the theme-override directory with a README on first run.

    Never touches an existing directory beyond that — an operator's
    override.css/logo.svg (or their absence) is left exactly as-is.
    """
    try:
        readme = directory / "README.md"
        if readme.exists():
            return
        directory.mkdir(parents=True, exist_ok=True)
        readme.write_text(
            "# Nimbus theme overrides\n\n"
            "Drop files here to change Nimbus's look and feel without rebuilding\n"
            "the frontend. This directory is served at /theme/ and survives snap\n"
            "refreshes. Nothing here is required — Nimbus ships its own defaults\n"
            "and only loads what it finds.\n\n"
            "## override.css\n\n"
            "Nimbus's entire UI is styled from CSS custom properties defined in\n"
            "one place (frontend/src/theme.css in the source tree). Redeclare any\n"
            "of them here and the whole app picks it up — colors, spacing, radius,\n"
            "shadows, fonts. Example:\n\n"
            "```css\n"
            ":root {\n"
            "  --color-accent: #3E8CA8;       /* primary buttons, focus rings, badges */\n"
            "  --color-bg-canvas: #0a0f14;    /* base background */\n"
            "  --font-sans: 'Inter', sans-serif;\n"
            "  --nimbus-gradient-hue: 200;    /* hue of the ambient home-screen background */\n"
            "}\n"
            "```\n\n"
            "See theme.css in the frontend source for the full token list.\n\n"
            "## logo.svg\n\n"
            "Drop a square SVG (any viewBox) here to replace the cloud logomark shown\n"
            "on the onboarding, login, and kiosk-ready screens.\n",
            encoding="utf-8",
        )
    except OSError as exc:
        logger.warning("Could not seed theme override dir %s: %s", directory, exc)


_LOCALHOST_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

# Header the relay stamps on a request when the *raw TCP peer* connecting to
# the plain-HTTP port was genuinely loopback — never client-supplied. Because
# every request proxied here re-originates as a fresh loopback connection to
# the HTTPS backend, request.client.host alone can't tell the backend whether
# a request actually came from this device or from any host on the LAN
# hitting port 80; this header carries that distinction across the relay.
TRUSTED_LOCAL_HEADER = b"x-nimbus-local"


def _set_or_strip_header(raw: bytes, name: bytes, value: bytes | None) -> bytes:
    """Remove any existing `name` header from a raw HTTP request and, if value
    is given, add `name: value` instead. Leaves `raw` untouched if the header
    block isn't fully present in the buffer yet (fails safe: no header added)."""
    sep = b"\r\n\r\n"
    idx = raw.find(sep)
    if idx == -1:
        return raw
    head, rest = raw[:idx], raw[idx + len(sep):]
    lines = head.split(b"\r\n")
    request_line, header_lines = lines[0], lines[1:]
    lname = name.lower()
    header_lines = [l for l in header_lines if not l.lower().startswith(lname + b":")]
    if value is not None:
        header_lines.append(name + b": " + value)
    return b"\r\n".join([request_line] + header_lines) + sep + rest


async def _run_http_redirect(http_port: int, https_port: int) -> None:
    """Accept plain-HTTP connections.

    * localhost / 127.0.0.1 / ::1 — transparently proxy to the local HTTPS
      backend so browsers never see a certificate warning for local access.
    * all other Host headers — return a 301 redirect to the HTTPS URL.
    """
    import asyncio
    import ssl

    async def _pipe(src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
        try:
            while True:
                chunk = await src.read(65536)
                if not chunk:
                    break
                dst.write(chunk)
                await dst.drain()
        except Exception:
            pass
        finally:
            try:
                dst.close()
            except Exception:
                pass

    async def _proxy_localhost(initial: bytes, client_r: asyncio.StreamReader,
                                client_w: asyncio.StreamWriter, trust_local: bool) -> None:
        """Forward the HTTP request to the local HTTPS backend and pipe back the response."""
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        try:
            backend_r, backend_w = await asyncio.open_connection(
                "127.0.0.1", https_port, ssl=ctx
            )
        except Exception as exc:
            logger.debug("localhost proxy connect failed: %s", exc)
            return
        initial = _set_or_strip_header(
            initial, TRUSTED_LOCAL_HEADER, b"1" if trust_local else None
        )
        backend_w.write(initial)
        await backend_w.drain()
        await asyncio.gather(
            _pipe(backend_r, client_w),
            _pipe(client_r, backend_w),
            return_exceptions=True,
        )

    async def _read_headers(reader: asyncio.StreamReader, limit: int = 65536) -> bytes:
        """Buffer reads until the full HTTP header block has arrived.

        A single reader.read(n) call returns as soon as *any* bytes are
        available — real browsers routinely write a request's many headers
        (Sec-*, User-Agent, ...) across more than one TCP segment, so one
        read is not guaranteed to capture the \r\n\r\n terminator. Without
        this loop, _set_or_strip_header silently sees a headers block it
        can't find the end of and skips adding the trust header.
        """
        buf = b""
        while b"\r\n\r\n" not in buf and len(buf) < limit:
            chunk = await asyncio.wait_for(reader.read(4096), timeout=5.0)
            if not chunk:
                break
            buf += chunk
        return buf

    async def _handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            # The peer of *this* socket is the real, unspoofable network-layer
            # origin of the request (unlike the Host header, which any client
            # can set to whatever it wants) — trust it only when it's loopback.
            peername = writer.get_extra_info("peername")
            trust_local = bool(peername) and peername[0] in _LOCALHOST_HOSTS
            raw = await _read_headers(reader)
            # Proxy all HTTP traffic straight through to the local HTTPS backend.
            # This enables the captive portal: when a phone on the nimbus AP
            # browses to any http:// URL, DNS (dnsmasq address=/#/10.42.0.1)
            # delivers the request here and we serve the OOBE over plain HTTP —
            # no certificate error, no redirect chain. Android/iOS captive-portal
            # probes get the OOBE HTML (not a 204/specific body), which triggers
            # the "Sign in to network" notification. http://nimbus.local also
            # benefits: no browser cert warning on the home network.
            await _proxy_localhost(raw, reader, writer, trust_local)
        except Exception:
            pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    server = await asyncio.start_server(_handle, "0.0.0.0", http_port)
    logger.info("HTTP captive-portal proxy listening on port %d → HTTPS %d", http_port, https_port)
    async with server:
        await server.serve_forever()


@asynccontextmanager
async def lifespan(app: FastAPI):
    store_task = None
    redirect_task = None
    ap_task = None
    if settings.tls_enabled:
        redirect_task = asyncio.create_task(
            _run_http_redirect(settings.http_redirect_port, int(os.environ.get("NIMBUS_PORT", "443")))
        )
    if settings.refresh_store_on_startup and settings.app_store_type != "nimbus":
        logger.info("Refreshing app store on startup...")
        try:
            await refresh_store()
        except Exception as exc:
            logger.warning("Store refresh failed (continuing anyway): %s", exc)
        store_task = asyncio.create_task(ensure_store())

    if settings.control_mode == "lxd":
        from services import wifi as wifi_service
        logger.info("Scheduling startup AP management task...")
        ap_task = asyncio.create_task(wifi_service.check_and_manage_ap_on_startup())

    await get_control_plane().initialize()
    openclaw_service.start()
    yield
    if ap_task and not ap_task.done():
        ap_task.cancel()
        try:
            await ap_task
        except asyncio.CancelledError:
            pass
    if redirect_task and not redirect_task.done():
        redirect_task.cancel()
        try:
            await redirect_task
        except asyncio.CancelledError:
            pass
    if store_task and not store_task.done():
        store_task.cancel()
        try:
            await store_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Nimbus", version=os.environ.get("SNAP_VERSION", "dev"), lifespan=lifespan)

# Build CORS origin list from settings.  An empty NIMBUS_CORS_ORIGINS env var
# means "allow all" (backwards-compatible with the previous wildcard config).
_cors_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()] if settings.cors_origins else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def captive_portal_middleware(request, call_next):
    response = await call_next(request)
    if (
        response.status_code == 404
        and request.url.path != "/"
        and not request.url.path.startswith("/api/")
        and not request.url.path.startswith("/ws/")
        # A missing theme override (the common case — nothing dropped in
        # $SNAP_COMMON/theme yet) must 404 cleanly. Otherwise this turns into
        # a redirect to "/", and e.g. a HEAD check for logo.svg would come
        # back 200 (redirected to index.html) and be mistaken for an override
        # actually existing.
        and not request.url.path.startswith("/theme/")
    ):
        from fastapi.responses import RedirectResponse
        host = request.headers.get("host", "").lower()
        if any(h in host for h in ("localhost", "127.0.0.1", "nimbus.local", "192.168.")):
            return RedirectResponse(url="/")
        return RedirectResponse(url="http://10.42.0.1/")
    return response


app.include_router(auth_router)  # no auth dependency — handles login/logout/setup
app.include_router(apps_router)
app.include_router(files_router)
app.include_router(network_router)
app.include_router(openclaw_router)
app.include_router(snap_store_router)
app.include_router(system_router)
app.include_router(terminal_router)
app.include_router(snapshots_router)
app.include_router(firewall_router)
app.include_router(models_router)
app.include_router(keys_router)
app.include_router(model_router_router)
app.include_router(tailscale_router)

# Must be mounted before the catch-all "/" frontend mount below, or that
# mount (which matches every path as a prefix) would shadow it.
_seed_theme_override_dir(settings.theme_override_dir)
if settings.theme_override_dir.is_dir():
    app.mount("/theme", StaticFiles(directory=str(settings.theme_override_dir)), name="theme_override")
if settings.serve_frontend and STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="frontend")
