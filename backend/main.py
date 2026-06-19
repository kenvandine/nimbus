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
from routers.ssh import router as ssh_router
from routers.models import router as models_router
from routers.keys import router as keys_router
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


async def _run_http_redirect(http_port: int, https_port: int) -> None:
    """Accept plain-HTTP connections and return a 301 redirect to HTTPS."""
    import asyncio

    async def _handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            raw = await asyncio.wait_for(reader.read(4096), timeout=5.0)
            path = "/"
            host = "localhost"
            lines = raw.split(b"\r\n")
            if lines:
                parts = lines[0].split()
                if len(parts) >= 2:
                    path = parts[1].decode(errors="replace")
            for line in lines[1:]:
                if line.lower().startswith(b"host:"):
                    host = line[5:].decode(errors="replace").strip().split(":")[0]
                    break
            port_suffix = f":{https_port}" if https_port != 443 else ""
            location = f"https://{host}{port_suffix}{path}"
            writer.write(
                f"HTTP/1.1 301 Moved Permanently\r\n"
                f"Location: {location}\r\n"
                f"Content-Length: 0\r\n"
                f"Connection: close\r\n\r\n".encode()
            )
            await writer.drain()
        except Exception:
            pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    server = await asyncio.start_server(_handle, "0.0.0.0", http_port)
    logger.info("HTTP→HTTPS redirect listening on port %d", http_port)
    async with server:
        await server.serve_forever()


@asynccontextmanager
async def lifespan(app: FastAPI):
    store_task = None
    redirect_task = None
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
    await get_control_plane().initialize()
    openclaw_service.start()
    yield
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
app.include_router(ssh_router)
app.include_router(models_router)
app.include_router(keys_router)

if settings.serve_frontend and STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="frontend")
