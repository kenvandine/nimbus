"""Control plane abstraction for Nimbus.

Provides three implementations:
  - LocalControlPlane: manages Docker apps directly (local mode)
  - LxdControlPlane: manages apps inside an LXC container (lxd mode)
  - RemoteControlPlane: proxies to a remote Nimbus instance (remote mode)

Shared logic (install tracking, system commands) is in control_base.py.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Protocol

import httpx
import psutil
from fastapi import HTTPException
from pylxd.exceptions import ClientConnectionFailed, LXDAPIException

from config import MODEL_PROVIDER_LEMONADE, settings
from constants import SNAP_UI_PORTS
from models import AppDetail, AppStatus, SystemStats
from services.control_base import ControlPlaneBase
from services.device import get_device_manager, is_oobe_complete
from services import docker, model_provider, network, store, system_apps

logger = logging.getLogger(__name__)

_PRESEED_STATE = ".preseed_apps_state"

# Cached openclaw token to avoid reading the config file on every request.
_openclaw_token: str | None = None
_openclaw_token_checked: bool = False


async def _get_openclaw_token() -> str | None:
    """Read the openclaw auth token from the container config file (cached)."""
    global _openclaw_token, _openclaw_token_checked
    if _openclaw_token_checked:
        return _openclaw_token
    try:
        from services import container_snaps
        content = await container_snaps.read_container_file(
            "/home/nimbus/.openclaw/openclaw.json"
        )
        if content:
            data = json.loads(content)
            _openclaw_token = (
                data.get("gateway", {}).get("auth", {}).get("token") or None
            )
    except Exception as exc:
        logger.debug("Could not read openclaw token: %s", exc)
    _openclaw_token_checked = True
    return _openclaw_token


async def _patch_openclaw_config() -> None:
    """Set gateway.controlUi.allowInsecureAuth=true in openclaw.json."""
    from services import container_snaps
    _CONFIG = "/home/nimbus/.openclaw/openclaw.json"
    content = await container_snaps.read_container_file(_CONFIG)
    if not content:
        logger.warning("openclaw.json not found — skipping insecure-auth patch")
        return
    try:
        cfg = json.loads(content)
    except json.JSONDecodeError as exc:
        logger.warning("Could not parse openclaw.json: %s", exc)
        return
    gateway = cfg.setdefault("gateway", {})
    control_ui = gateway.setdefault("controlUi", {})
    if control_ui.get("allowInsecureAuth") is True:
        return
    control_ui["allowInsecureAuth"] = True
    ok = await container_snaps.write_container_file(_CONFIG, json.dumps(cfg, indent=2))
    if ok:
        logger.info("Patched openclaw.json: allowInsecureAuth=true")
        _invalidate_openclaw_token_cache()
    else:
        logger.warning("Failed to write patched openclaw.json")


def _invalidate_openclaw_token_cache() -> None:
    """Call after openclaw is installed/uninstalled so the token is re-read."""
    global _openclaw_token, _openclaw_token_checked
    _openclaw_token = None
    _openclaw_token_checked = False


def _load_preseed_state(data_dir: Path) -> set[str]:
    try:
        return set(json.loads((data_dir / _PRESEED_STATE).read_text()))
    except Exception:
        return set()


def _save_preseed_state(data_dir: Path, queued: set[str]) -> None:
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        (data_dir / _PRESEED_STATE).write_text(json.dumps(sorted(queued)))
    except OSError as exc:
        logger.warning("Could not write preseed-apps state: %s", exc)


def _ensure_openclaw_workspace_link() -> None:
    """Expose the OpenClaw workspace dir to the file browser."""
    import os
    link = settings.files_root / "openclaw-workspace"
    try:
        link.parent.mkdir(parents=True, exist_ok=True)
        if settings.control_mode == "lxd":
            if link.is_symlink():
                link.unlink()
            link.mkdir(exist_ok=True)
            try:
                os.chmod(link, 0o777)
            except OSError:
                pass
            return
        target = settings.installed_dir / "openclaw" / "data" / "data" / ".openclaw" / "workspace"
        if link.is_symlink() or link.exists():
            return
        link.symlink_to(target)
        logger.info("Created file-browser symlink %s -> %s", link, target)
    except OSError as exc:
        logger.warning("Could not set up openclaw-workspace link: %s", exc)


async def _maybe_ensure_model_provider(_cp: "ControlPlane") -> None:
    """Fire the configured model-provider's prep task at startup.

    Always fires unconditionally for any configured provider.

    For lemonade: ``ensure_model()`` is a fast no-op when the model is already
    installed, so this is safe on every boot.  It ensures the default model is
    pulled as early as possible — covering:
      - Fresh OOBE on a ``download=false`` image: model starts pulling
        immediately while the user is still setting up apps.
      - Reboots where the model was never fully downloaded: pull resumes.
      - Normal boots where the model is present: quick check, no download.

    For gemma4: ``wait_until_ready_task()`` polls until the snap is reachable;
    harmless no-op if gemma4 isn't configured.

    We do NOT gate on any specific app (e.g. openclaw) being installed — the
    model provider should always be ready regardless of which apps are present.
    """
    model_provider.ensure_ready_task()


async def _maybe_ensure_model_router(_cp: "ControlPlane") -> None:
    """Fire the model_router startup reconciliation task.

    The router collection (model_router.ROUTER_MODEL_NAME) must always exist
    once lemond is reachable, regardless of whether cloud offload is enabled —
    every claw app's provider config points at it permanently. lemond's
    runtime cloud API keys are memory-only and die on lemond restart, so this
    also re-applies any configured cloud providers from Nimbus's own encrypted
    store, which is the durable source of truth.

    Chained behind model_provider.wait_until_ready() rather than fired
    immediately: registering a collection in lemonade requires its component
    model to already be registered there, and on a fresh image the active
    model only gets registered by the ensure/pull task fired just above. The
    reconcile still runs even if the wait reports failure — the model may be
    registered from an earlier boot, and reconcile fails open regardless.
    Fire-and-forget so initialize() doesn't block on lemonade.
    """
    if settings.model_provider != MODEL_PROVIDER_LEMONADE:
        return
    from services import model_router

    async def _reconcile_when_provider_ready() -> None:
        await model_provider.wait_until_ready()
        await model_router.reconcile_on_startup()
        await run_lemonade_autoconfig()

    asyncio.create_task(_reconcile_when_provider_ready())


async def _maybe_start_usage_metrics(_cp: "ControlPlane") -> None:
    """Start the lemonade `/metrics` polling loop that tracks the local-vs-cloud
    request split (services.usage_metrics). Only meaningful when lemonade is the
    active model provider, same gate as _maybe_ensure_model_router."""
    if settings.model_provider != MODEL_PROVIDER_LEMONADE:
        return
    from services import usage_metrics
    asyncio.create_task(usage_metrics.poll_loop())


async def _maybe_install_preseed_apps(cp: "ControlPlane") -> None:
    """Queue installs for any preseed apps not yet seen on this device."""
    if not settings.preseed_apps:
        return
    data_dir = settings.installed_dir.parent
    already = _load_preseed_state(data_dir)
    new_apps = [a for a in settings.preseed_apps if a not in already]
    if not new_apps:
        return
    logger.info("Queuing install for new preseed apps: %s", new_apps)
    for app_id in new_apps:
        try:
            await cp.request_install(app_id)
        except Exception as exc:
            logger.warning("Failed to queue preseed app %s: %s", app_id, exc)
    _save_preseed_state(data_dir, already | set(new_apps))


class ControlPlane(Protocol):
    async def initialize(self) -> None: ...
    async def list_apps(self) -> list[AppDetail]: ...
    async def get_app(self, app_id: str) -> AppDetail: ...
    async def request_install(self, app_id: str) -> dict: ...
    async def request_update(self, app_id: str) -> dict: ...
    async def uninstall_app(self, app_id: str) -> dict: ...
    async def active_installs(self) -> list[str]: ...
    async def get_stats(self) -> SystemStats: ...
    async def restart_system(self) -> dict: ...
    async def power_off_system(self) -> dict: ...
    async def update_system(self) -> dict: ...
    async def get_ca_cert(self) -> tuple[bytes, str, str]: ...


def _apply_device_stats(stats: SystemStats) -> SystemStats:
    """Apply device-specific fields to a SystemStats instance."""
    stats.version = os.environ.get("SNAP_VERSION", "")
    device_status = get_device_manager().status()
    stats.device_management_available = device_status.actions_available
    stats.system_update_supported = device_status.system_update_supported
    stats.system_update_available = device_status.system_update_available
    stats.system_update_targets = device_status.system_update_targets
    stats.system_update_status = device_status.system_update_status
    stats.system_update_message = device_status.system_update_message
    stats.system_restart_required = device_status.system_restart_required
    try:
        stats.host_ip = network.get_primary_interface_ip()
    except Exception:
        pass
    if stats.control_mode == "lxd" and stats.container_bootstrapped and stats.bootstrap_state == "ready":
        stats.terminal_available = True
    try:
        from services.tls import get_cert_fingerprint
        import os as _os
        stats.tls_enabled = _os.environ.get("NIMBUS_TLS", "").strip().lower() in {"1", "true"}
        if stats.tls_enabled:
            stats.tls_fingerprint = get_cert_fingerprint()
    except Exception:
        pass
    stats.update_available_count = _app_update_count
    return stats


_app_update_count: int = 0
_UPDATE_CHECK_INTERVAL = 6 * 3600  # 6 hours


async def _run_update_check(cp: "ControlPlane") -> None:
    global _app_update_count
    try:
        # Refresh the store-side revision check first (nimbus mode) so the
        # update_available flags computed by list_apps reflect current state.
        refresh = getattr(cp, "refresh_snap_updates", None)
        if refresh is not None:
            await refresh()
        apps = await cp.list_apps()
        _app_update_count = sum(1 for a in apps if getattr(a, "update_available", False))
        logger.info("App update check complete: %d update(s) available", _app_update_count)
    except Exception as exc:
        logger.warning("App update check failed: %s", exc)


async def _update_check_loop(cp: "ControlPlane") -> None:
    while True:
        await asyncio.sleep(_UPDATE_CHECK_INTERVAL)
        await _run_update_check(cp)


# ---------------------------------------------------------------------------
# LocalControlPlane — manages Docker apps directly (local mode)
# ---------------------------------------------------------------------------


class LocalControlPlane(ControlPlaneBase):
    """Control plane for local mode: manages Docker apps directly."""

    def __init__(self) -> None:
        super().__init__()

    async def initialize(self) -> None:
        _ensure_openclaw_workspace_link()
        await _maybe_install_preseed_apps(self)
        await _maybe_ensure_model_provider(self)
        await _maybe_ensure_model_router(self)
        await _maybe_start_usage_metrics(self)
        asyncio.create_task(_update_check_loop(self))

    async def _status_for(self, app_id: str, meta=None) -> AppStatus:
        installed = app_id in docker.installed_app_ids()
        if not installed:
            return AppStatus(installed=False)
        running = await docker.is_running(app_id)
        port = None
        open_url = None
        if running:
            port = await docker.get_web_port(app_id)
            if not port:
                m = meta or store.get_app_meta(app_id)
                port = m.port_hint if m else None
            if port:
                host_ip = await network.get_host_ip()
                open_url = network.build_open_url(host_ip, port)
        update_available = False
        if meta and meta.version:
            installed_ver = docker.get_installed_version(app_id)
            update_available = bool(installed_ver and installed_ver != meta.version)
        return AppStatus(
            installed=True, running=running, port=port,
            open_url=open_url, update_available=update_available,
        )

    def _build_detail(self, meta, status: AppStatus) -> AppDetail:
        data = {**meta.model_dump(), **status.model_dump()}
        if status.installed and meta.deterministic_password:
            data["default_password"] = docker.get_app_password(meta.id)
        return AppDetail(**data)

    async def list_apps(self) -> list[AppDetail]:
        installed_ids = set(docker.installed_app_ids())
        metas = store.list_apps(extra_ids=installed_ids)
        statuses = await asyncio.gather(*[self._status_for(m.id, m) for m in metas])
        host_ip = await network.get_host_ip()
        sys_apps = await system_apps.get_system_apps(host_ip)
        return sys_apps + [self._build_detail(m, s) for m, s in zip(metas, statuses)]

    async def get_app(self, app_id: str) -> AppDetail:
        if app_id == "lemonade":
            host_ip = await network.get_host_ip()
            return system_apps.get_lemonade_app(host_ip)
        if app_id == "gemma4":
            host_ip = await network.get_host_ip()
            return system_apps.get_gemma4_app(host_ip)
        meta = store.get_app_meta(app_id)
        if meta is None:
            raise HTTPException(status_code=404, detail=f"App '{app_id}' not found in store")
        status = await self._status_for(app_id, meta)
        return self._build_detail(meta, status)

    async def _do_install(self, app_id: str) -> None:
        self._installing.add(app_id)
        try:
            if app_id == "openclaw":
                # Start model pull now so it runs concurrently with the docker
                # image download; if already in progress this is a no-op.
                model_provider.ensure_ready_task()
            await docker.install_app(app_id)
        except Exception as exc:
            logger.error("Install failed for %s: %s", app_id, exc)
        finally:
            self._installing.discard(app_id)

    async def _do_update(self, app_id: str) -> None:
        self._updating.add(app_id)
        try:
            await docker.update_app(app_id)
        except Exception as exc:
            logger.error("Update failed for %s: %s", app_id, exc)
        finally:
            self._updating.discard(app_id)

    async def request_install(self, app_id: str) -> dict:
        if store.get_app_meta(app_id) is None:
            raise HTTPException(status_code=404, detail=f"App '{app_id}' not found in store")
        if app_id in self._installing:
            return {"status": "already_installing"}
        if app_id in docker.installed_app_ids():
            return {"status": "already_installed"}
        asyncio.create_task(self._do_install(app_id))
        return {"status": "installing"}

    async def request_update(self, app_id: str) -> dict:
        if app_id not in docker.installed_app_ids():
            raise HTTPException(status_code=404, detail=f"App '{app_id}' is not installed")
        if app_id in self._updating:
            return {"status": "already_updating"}
        asyncio.create_task(self._do_update(app_id))
        return {"status": "updating"}

    async def uninstall_app(self, app_id: str) -> dict:
        if app_id not in docker.installed_app_ids():
            raise HTTPException(status_code=404, detail=f"App '{app_id}' is not installed")
        await docker.uninstall_app(app_id)
        return {"status": "uninstalled"}

    async def get_stats(self) -> SystemStats:
        from services.hardware import best_disk_path
        disk_path = best_disk_path()
        disk = psutil.disk_usage(disk_path)
        mem = psutil.virtual_memory()
        return _apply_device_stats(SystemStats(
            cpu_pct=psutil.cpu_percent(interval=0.1),
            mem_pct=mem.percent,
            mem_used_gb=round(mem.used / (1024 ** 3), 1),
            mem_total_gb=round(mem.total / (1024 ** 3), 1),
            disk_pct=disk.percent,
            disk_used_gb=round(disk.used / (1024 ** 3), 1),
            disk_total_gb=round(disk.total / (1024 ** 3), 1),
            app_count=len(docker.installed_app_ids()),
            oobe_complete=True, online=True,
            appstore_visible=settings.appstore_visible,
            app_store_type=settings.app_store_type,
        ))

    async def get_ca_cert(self) -> tuple[bytes, str, str]:
        cert_path = settings.caddy_ca_cert
        if not cert_path.exists():
            raise HTTPException(
                status_code=404,
                detail="CA certificate not yet generated — Caddy may still be starting up",
            )
        return (
            cert_path.read_bytes(),
            "application/x-x509-ca-cert",
            "nimbus-ca.crt",
        )


# ---------------------------------------------------------------------------
# RemoteControlPlane — proxies to a remote Nimbus instance
# ---------------------------------------------------------------------------


class RemoteControlPlane:
    """Control plane for remote mode: proxies API calls to a remote Nimbus."""

    def __init__(self, base_url: str, token: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def _headers(self) -> dict[str, str]:
        if not self.token:
            return {}
        return {"Authorization": f"Bearer {self.token}"}

    async def initialize(self) -> None:
        return None

    async def _json(self, method: str, path: str) -> dict | list:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.request(
                method, f"{self.base_url}{path}", headers=self._headers(),
            )
        if response.is_error:
            raise HTTPException(status_code=response.status_code, detail=response.text)
        return response.json()

    async def _content(self, path: str) -> tuple[bytes, str, str]:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(
                f"{self.base_url}{path}", headers=self._headers(),
            )
        if response.is_error:
            raise HTTPException(status_code=response.status_code, detail=response.text)
        content_type = response.headers.get("content-type", "application/octet-stream")
        return response.content, content_type, "nimbus-ca.crt"

    async def list_apps(self) -> list[AppDetail]:
        data = await self._json("GET", "/api/apps")
        return [AppDetail.model_validate(item) for item in data]

    async def get_app(self, app_id: str) -> AppDetail:
        data = await self._json("GET", f"/api/apps/{app_id}")
        return AppDetail.model_validate(data)

    async def request_install(self, app_id: str) -> dict:
        data = await self._json("POST", f"/api/apps/{app_id}/install")
        return dict(data)

    async def request_update(self, app_id: str) -> dict:
        data = await self._json("POST", f"/api/apps/{app_id}/update")
        return dict(data)

    async def uninstall_app(self, app_id: str) -> dict:
        data = await self._json("POST", f"/api/apps/{app_id}/uninstall")
        return dict(data)

    async def active_installs(self) -> list[str]:
        data = await self._json("GET", "/api/apps/installing/active")
        return [str(item) for item in data]

    async def get_stats(self) -> SystemStats:
        data = await self._json("GET", "/api/system/stats")
        return SystemStats.model_validate(data)

    async def restart_system(self) -> dict:
        data = await self._json("POST", "/api/system/restart")
        return dict(data)

    async def power_off_system(self) -> dict:
        data = await self._json("POST", "/api/system/poweroff")
        return dict(data)

    async def update_system(self) -> dict:
        data = await self._json("POST", "/api/system/update")
        return dict(data)

    async def get_ca_cert(self) -> tuple[bytes, str, str]:
        return await self._content("/api/system/ca-cert")


# ---------------------------------------------------------------------------
# LxdControlPlane — manages apps inside an LXC container
# ---------------------------------------------------------------------------


class LxdControlPlane(ControlPlaneBase):
    """Control plane for LXD mode: manages apps inside an LXC container."""

    def __init__(self) -> None:
        from services.lxd import get_lxd_manager
        super().__init__()
        self.manager = get_lxd_manager()
        self._bootstrap_task: asyncio.Task | None = None
        self._waiting_for_network: bool = False

    async def initialize(self) -> None:
        if settings.lxd_auto_bootstrap and self._bootstrap_task is None:
            self._bootstrap_task = asyncio.create_task(self._bootstrap_when_online())
        asyncio.create_task(self._unmanage_loop())
        if settings.app_store_type == "nimbus":
            asyncio.create_task(self._snap_update_check_loop())

    async def refresh_snap_updates(self) -> None:
        """Cache the names of container snaps with a pending store update.

        Backed by `snap refresh --list` in the agent — a revision-based check
        against each snap's tracked channel, independent of the catalog.
        """
        from services import container_snaps
        try:
            refreshes = await container_snaps.list_snap_refreshes()
            self._snap_updates = {s["name"] for s in refreshes if s.get("name")}
            logger.info(
                "Store update check: %d snap(s) with a pending update",
                len(self._snap_updates),
            )
        except Exception as exc:
            logger.warning("Could not refresh snap update list: %s", exc)

    async def _snap_update_check_loop(self) -> None:
        # Wait for the container/agent to come up, do an initial check so labels
        # appear without waiting a full interval, then check periodically.
        await asyncio.sleep(120)
        await _run_update_check(self)
        await _update_check_loop(self)

    async def _unmanage_loop(self) -> None:
        while True:
            try:
                await asyncio.to_thread(self.manager._unmanage_lxd_devices_via_dbus)
            except Exception as exc:
                logger.debug("Error in NM unmanage loop: %s", exc)
            await asyncio.sleep(30)

    async def _bootstrap_when_online(self) -> None:
        from services.network import is_online
        if not await asyncio.to_thread(is_online):
            self._waiting_for_network = True
            logger.info("Waiting for network connectivity before LXD bootstrap...")
            while not await asyncio.to_thread(is_online):
                await asyncio.sleep(10)
            self._waiting_for_network = False
            logger.info("Network is up, starting LXD bootstrap")
        for attempt in range(5):
            try:
                await asyncio.to_thread(self.manager.ensure_bootstrapped)
                break
            except Exception as exc:
                if attempt < 4:
                    logger.warning(
                        "Bootstrap attempt %d/5 failed, retrying in 30s: %s",
                        attempt + 1, exc,
                    )
                    await asyncio.sleep(30)
                    continue
                raise
        _ensure_openclaw_workspace_link()
        if settings.app_store_type == "nimbus":
            from services import nimbus_store
            await nimbus_store.get_catalog()
        await _maybe_install_preseed_apps(self)
        await _maybe_ensure_model_provider(self)
        await _maybe_ensure_model_router(self)
        await _maybe_start_usage_metrics(self)
        asyncio.create_task(_update_check_loop(self))

    def _raise_manager_error(self, exc: Exception) -> HTTPException:
        return HTTPException(status_code=500, detail=str(exc))

    async def _call_manager(self, func, *args):
        try:
            return await asyncio.to_thread(func, *args)
        except HTTPException:
            raise
        except (ClientConnectionFailed, LXDAPIException, RuntimeError) as exc:
            raise self._raise_manager_error(exc) from exc

    def _build_detail(self, meta, status: AppStatus, default_password: str = "") -> AppDetail:
        data = {**meta.model_dump(), **status.model_dump()}
        if status.installed and meta.deterministic_password:
            if default_password:
                data["default_password"] = default_password
        return AppDetail(**data)

    def _container_ready(self, info) -> bool:
        return (
            info.exists and info.status == "running"
            and info.bootstrapped and info.bootstrap_state == "ready"
            and not info.bootstrap_error
        )

    def _status_for_sync(self, app_id: str, meta, info, snapshot, host_ip: str | None = None) -> tuple[AppStatus, str]:
        app_state = snapshot.installed.get(app_id) if snapshot else None
        if not app_state:
            return AppStatus(installed=False), ""
        running = bool(app_state.get("running"))
        port = app_state.get("port")
        if not isinstance(port, int):
            port = None
        if running and not port:
            port = meta.port_hint if meta else None
        open_host = host_ip or info.ip_address
        open_url = network.build_open_url(open_host, port) if running and port and open_host else None
        installed_ver = str(app_state.get("version") or "")
        update_available = bool(meta and meta.version and installed_ver and installed_ver != meta.version)
        status = AppStatus(
            installed=True, running=running, port=port,
            open_url=open_url, update_available=update_available,
        )
        return status, str(app_state.get("password") or "")

    def _list_apps_sync(self, host_ip: str | None = None) -> list[AppDetail]:
        info = self.manager.container_info()
        snapshot = self.manager.app_runtime_snapshot() if self._container_ready(info) else None
        installed_ids = set(snapshot.installed.keys()) if snapshot else set()
        metas = store.list_apps(extra_ids=installed_ids)
        details: list[AppDetail] = []
        for meta in metas:
            status, default_password = self._status_for_sync(meta.id, meta, info, snapshot, host_ip)
            details.append(self._build_detail(meta, status, default_password))
        return details

    async def list_apps(self) -> list[AppDetail]:
        host_ip = await network.get_host_ip()
        sys = await system_apps.get_system_apps(host_ip)
        if settings.app_store_type == "nimbus":
            nimbus_apps = await self._list_nimbus_apps(host_ip)
            return sys + nimbus_apps
        store_apps = await self._call_manager(self._list_apps_sync, host_ip)
        snap_apps = await self._list_snap_apps(host_ip)
        return sys + store_apps + snap_apps

    async def _list_snap_apps(self, host_ip: str | None) -> list[AppDetail]:
        from services import snap_store, container_snaps
        try:
            snap_metas, installed_snaps = await asyncio.gather(
                snap_store.get_catalog_app_metas(),
                container_snaps.list_container_snaps(),
            )
        except Exception as exc:
            logger.warning("Could not list snap catalog apps: %s", exc)
            return []
        installed_map = {s["name"]: s for s in installed_snaps}
        result: list[AppDetail] = []
        for meta in snap_metas:
            snap_info = installed_map.get(meta.id)
            if snap_info:
                port = meta.ports[0] if meta.ports else SNAP_UI_PORTS.get(meta.id)
                open_url = network.build_open_url(host_ip, port) if port and host_ip else None
                status = AppStatus(installed=True, running=True, port=port, open_url=open_url)
            else:
                status = AppStatus(installed=False)
            result.append(AppDetail(**{**meta.model_dump(), **status.model_dump()}))
        return result

    async def _list_nimbus_apps(self, host_ip: str | None) -> list[AppDetail]:
        from services import nimbus_store, container_snaps
        try:
            catalog, metas, installed_snaps = await asyncio.gather(
                nimbus_store.get_catalog(),
                nimbus_store.get_app_metas(),
                container_snaps.list_container_snaps(),
            )
        except Exception as exc:
            logger.warning("Could not list nimbus store apps: %s", exc)
            return []
        installed_map = {s["name"]: s for s in installed_snaps}
        openclaw_token = await _get_openclaw_token()

        async def _service_status(meta_id: str) -> tuple[bool, bool]:
            """Returns (has_service, is_running)."""
            snap = nimbus_store.get_snap(catalog, meta_id)
            if snap is None:
                return False, True
            service_name = nimbus_store.get_service_name(snap)
            if not service_name:
                return False, True
            running = await container_snaps.check_service_active(service_name)
            return True, running

        installed_ids = [meta.id for meta in metas if meta.id in installed_map]
        svc_results = await asyncio.gather(
            *[_service_status(mid) for mid in installed_ids],
            return_exceptions=True,
        )
        svc_map: dict[str, tuple[bool, bool]] = {}
        for mid, res in zip(installed_ids, svc_results):
            svc_map[mid] = res if not isinstance(res, Exception) else (False, True)

        result: list[AppDetail] = []
        for meta in metas:
            snap_info = installed_map.get(meta.id)
            if snap_info:
                has_service, running = svc_map.get(meta.id, (False, True))
                # Revision-based: the snap appears in the store refresh list
                # (populated by the update-check loop) when a newer revision is
                # available on its tracked channel. Not derived from the catalog.
                snap = nimbus_store.get_snap(catalog, meta.id)
                store_name = nimbus_store.get_store_name(snap) if snap else meta.id
                update_available = store_name in self._snap_updates
                port = meta.ports[0] if meta.ports else SNAP_UI_PORTS.get(meta.id)
                open_url = network.build_open_url(host_ip, port) if port and host_ip and running else None
                if open_url and meta.id == "openclaw" and openclaw_token:
                    open_url = f"{open_url}?token={openclaw_token}"
                status = AppStatus(
                    installed=True, running=running, port=port,
                    open_url=open_url, update_available=update_available,
                )
                result.append(AppDetail(**{**meta.model_dump(), **status.model_dump(), "has_service": has_service}))
            else:
                result.append(AppDetail(**{**meta.model_dump(), **AppStatus().model_dump()}))
        return result

    async def get_app(self, app_id: str) -> AppDetail:
        if app_id == "lemonade":
            host_ip = await network.get_host_ip()
            return system_apps.get_lemonade_app(host_ip)
        if app_id == "gemma4":
            host_ip = await network.get_host_ip()
            return system_apps.get_gemma4_app(host_ip)
        if settings.app_store_type == "nimbus":
            apps = await self._list_nimbus_apps(await network.get_host_ip())
            detail = next((a for a in apps if a.id == app_id), None)
            if detail is None:
                raise HTTPException(status_code=404, detail=f"App '{app_id}' not found in nimbus store")
            return detail
        from services import snap_store, container_snaps
        if snap_store.is_snap_catalog_app(app_id):
            snap_apps = await self._list_snap_apps(await network.get_host_ip())
            detail = next((a for a in snap_apps if a.id == app_id), None)
            if detail is None:
                raise HTTPException(status_code=404, detail=f"App '{app_id}' not found in snap catalog")
            return detail
        meta = store.get_app_meta(app_id)
        if meta is None:
            raise HTTPException(status_code=404, detail=f"App '{app_id}' not found in store")
        try:
            info = await self._call_manager(self.manager.container_info)
            snapshot = await self._call_manager(self.manager.app_runtime_snapshot) if self._container_ready(info) else None
            host_ip = await network.get_host_ip()
            status, default_password = await self._call_manager(
                self._status_for_sync, app_id, meta, info, snapshot, host_ip,
            )
        except HTTPException as exc:
            if exc.status_code == 500:
                status = AppStatus(installed=False)
                default_password = ""
            else:
                raise
        return self._build_detail(meta, status, default_password)

    _NETWORK_ERROR_HINTS = frozenset([
        "lookup", "i/o timeout", "dial tcp", "resolve reference",
        "no such host", "connection refused", "network unreachable",
        "toomanyrequests", "connection reset", "context deadline exceeded",
        "tls handshake timeout", "eof", "unexpected eof", "failed to pull",
        "pulling fs layer", "downloading",
    ])

    @classmethod
    def _is_network_error(cls, exc: Exception) -> bool:
        msg = str(exc).lower()
        return any(hint in msg for hint in cls._NETWORK_ERROR_HINTS)

    async def _do_install(self, app_id: str) -> None:
        # Legacy docker/umbrel-store path — never called in nimbus mode.
        if settings.app_store_type == "nimbus":
            logger.warning("_do_install called in nimbus mode for %s — skipping", app_id)
            return
        self._installing.add(app_id)
        logger.info("Starting install for %s", app_id)
        try:
            for attempt in range(1, 4):
                try:
                    await asyncio.to_thread(self.manager.install_app, app_id)
                    logger.info("Install completed for %s", app_id)
                    return
                except Exception as exc:
                    if attempt < 3 and self._is_network_error(exc):
                        delay = 30 * attempt
                        logger.warning(
                            "Install attempt %d for %s failed (network error), retrying in %ds: %s",
                            attempt, app_id, delay, exc,
                        )
                        await asyncio.sleep(delay)
                    else:
                        raise
        except Exception as exc:
            logger.error("Install failed for %s: %s", app_id, exc)
        finally:
            self._installing.discard(app_id)

    async def _do_update(self, app_id: str) -> None:
        # Legacy docker/umbrel-store path — never called in nimbus mode.
        if settings.app_store_type == "nimbus":
            logger.warning("_do_update called in nimbus mode for %s — skipping", app_id)
            return
        self._updating.add(app_id)
        logger.info("Starting update for %s", app_id)
        try:
            for attempt in range(1, 4):
                try:
                    await asyncio.to_thread(self.manager.update_app, app_id)
                    logger.info("Update completed for %s", app_id)
                    return
                except Exception as exc:
                    if attempt < 3 and self._is_network_error(exc):
                        delay = 30 * attempt
                        logger.warning(
                            "Update attempt %d for %s failed (network error), retrying in %ds: %s",
                            attempt, app_id, delay, exc,
                        )
                        await asyncio.sleep(delay)
                    else:
                        raise
        except Exception as exc:
            logger.error("Update failed for %s: %s", app_id, exc)
        finally:
            self._updating.discard(app_id)

    async def _request_nimbus_install(self, snap_name: str) -> dict:
        from services import nimbus_store, container_snaps
        catalog = await nimbus_store.get_catalog()
        if nimbus_store.get_snap(catalog, snap_name) is None:
            raise HTTPException(status_code=404, detail=f"App '{snap_name}' not found in nimbus store")
        if snap_name in self._installing:
            return {"status": "already_installing"}
        installed = await container_snaps.list_container_snaps()
        if any(s["name"] == snap_name for s in installed):
            return {"status": "already_installed"}
        self._installing.add(snap_name)
        asyncio.create_task(self._do_nimbus_sideload(snap_name, catalog))
        return {"status": "installing"}

    async def _do_nimbus_sideload(self, snap_name: str, catalog: dict | None = None) -> None:
        from services import nimbus_store, container_snaps
        try:
            if catalog is None:
                catalog = await nimbus_store.get_catalog()
            snap = nimbus_store.get_snap(catalog, snap_name)
            if snap is None:
                raise RuntimeError(f"App '{snap_name}' not found in nimbus store")
            channel = nimbus_store.get_channel(snap)
            flags = nimbus_store.get_install_flags(snap)
            if snap_name == "openclaw":
                # Start model pull now so it runs concurrently with the snap
                # download; if already in progress from startup this is a no-op.
                model_provider.ensure_ready_task()
            if channel:
                # Published to the Snap Store — install by name from its channel
                # (no --dangerous needed).
                store_name = nimbus_store.get_store_name(snap)
                classic = "--classic" in flags
                logger.info("Installing %s from store (channel=%s)", snap_name, channel)
                result = await container_snaps.install_container_snap(
                    store_name, channel=channel, classic=classic,
                )
                if not result.get("ok"):
                    raise RuntimeError(f"Store install failed: {result.get('stderr', '')}")
                logger.info("Store install completed for %s", snap_name)
            else:
                # Not yet in the store — sideload the GitHub release asset.
                url = nimbus_store.get_download_url(snap)
                filename = nimbus_store.get_filename(snap)
                if not url or not filename:
                    raise RuntimeError(f"No download URL for '{snap_name}' on this architecture")
                logger.info("Sideloading %s from %s", snap_name, url)
                result = await container_snaps.sideload_container_snap(url, filename, flags)
                if not result.get("ok"):
                    raise RuntimeError(f"Sideload failed: {result.get('stderr', '')}")
                logger.info("Sideload completed for %s", snap_name)
            ports = snap.get("ports", []) or (
                [SNAP_UI_PORTS[snap_name]] if snap_name in SNAP_UI_PORTS else []
            )
            if ports:
                await asyncio.to_thread(self.manager.setup_snap_port_proxies, snap_name, ports)
            onboard = nimbus_store.get_onboard_cmd(snap)
            if onboard:
                await asyncio.sleep(3)
                # Ensure the LXD proxy device bridging the host model service
                # (lemonade) into the container is in place before the onboard
                # command runs — without it the snap can't reach 127.0.0.1:PORT
                # inside the container and will fail silently, leaving the
                # service unit uninstalled.
                await asyncio.to_thread(self.manager.ensure_provider_proxy)
                logger.info("Ensuring model provider ready before onboard for %s", snap_name)
                task = model_provider.ensure_ready_task()
                if task is not None:
                    try:
                        await asyncio.wait_for(asyncio.shield(task), timeout=1800.0)
                    except asyncio.TimeoutError:
                        logger.warning(
                            "Model provider timed out waiting for %s onboard", snap_name,
                        )
                    except Exception as exc:
                        logger.warning(
                            "Model provider error before %s onboard (non-fatal): %s",
                            snap_name, exc,
                        )
                await asyncio.sleep(2)
                cmd, args = onboard
                active_model = model_provider.get_provider_config().model_id
                args = list(args) + ["--model", active_model]
                logger.info("Running onboard for %s: %s %s", snap_name, cmd, " ".join(args))
                try:
                    ob_result = await container_snaps.run_snap_cmd(cmd, args)
                    if ob_result.get("ok"):
                        logger.info("Onboard completed for %s", snap_name)
                    else:
                        logger.warning(
                            "Onboard returned non-zero for %s | stdout: %s | stderr: %s",
                            snap_name, ob_result.get("stdout", "").strip(),
                            ob_result.get("stderr", "").strip(),
                        )
                except Exception as exc:
                    logger.warning("Onboard failed for %s (non-fatal): %s", snap_name, exc)
            if snap_name == "openclaw":
                await _patch_openclaw_config()
            service_name = nimbus_store.get_service_name(snap)
            if service_name:
                try:
                    await container_snaps.reload_user_daemon()
                    svc = await container_snaps.service_action(service_name, "start")
                    if svc.get("ok"):
                        logger.info("Service %s started for %s", service_name, snap_name)
                    else:
                        logger.warning(
                            "Could not start service %s for %s | stdout: %s | stderr: %s",
                            service_name, snap_name, svc.get("stdout", "").strip(),
                            svc.get("stderr", "").strip(),
                        )
                except Exception as exc:
                    logger.warning(
                        "Could not start service %s for %s (non-fatal): %s",
                        service_name, snap_name, exc,
                    )

            # Run post-install script if defined in the catalog
            post_install = snap.get("post_install_script")
            if post_install:
                try:
                    base_url = catalog.get("base_url", "").rstrip("/")
                    script_url = f"{base_url}/{post_install.lstrip('/')}"
                    logger.info("Downloading post-install script for %s from %s", snap_name, script_url)
                    async with httpx.AsyncClient(timeout=30) as client:
                        resp = await client.get(script_url)
                        resp.raise_for_status()
                        script_content = resp.text

                    tmp_path = f"/home/nimbus/nimbus-post-install-{snap_name}.sh"

                    ok = await container_snaps.write_container_file(tmp_path, script_content)
                    if ok:
                        logger.info("Executing post-install script for %s", snap_name)
                        await asyncio.to_thread(self.manager.exec_in_container, ["chmod", "+x", tmp_path])

                        # Resolve the nimbus user UID inside the container dynamically.
                        _, uid_out, _ = await asyncio.to_thread(
                            self.manager.exec_in_container,
                            ["id", "-u", "nimbus"]
                        )
                        uid = uid_out.strip() or "1001"

                        exit_code, stdout, stderr = await asyncio.to_thread(
                            self.manager.exec_in_container,
                            [
                                "runuser", "-u", "nimbus", "--",
                                "env",
                                "HOME=/home/nimbus",
                                f"XDG_RUNTIME_DIR=/run/user/{uid}",
                                f"DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus",
                                "PATH=/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                                "bash", tmp_path
                            ]
                        )
                        logger.info(
                            "Post-install script for %s completed with exit code %d | stdout: %s | stderr: %s",
                            snap_name, exit_code, stdout.strip(), stderr.strip()
                        )
                        await asyncio.to_thread(self.manager.exec_in_container, ["rm", "-f", tmp_path])
                    else:
                        logger.warning("Could not write post-install script to container for %s", snap_name)
                except Exception as exc:
                    logger.warning("Post-install script failed for %s (non-fatal): %s", snap_name, exc)
        except Exception as exc:

            logger.error("Sideload failed for %s: %s", snap_name, exc)
        finally:
            self._installing.discard(snap_name)
            if snap_name == "openclaw":
                _invalidate_openclaw_token_cache()

    async def _do_nimbus_update(self, snap_name: str) -> None:
        """Update an installed store snap via `snap refresh`.

        The claw snaps run as a systemd *user* service that snapd does not
        manage, so refreshing alone won't stop their running processes. We
        stop the service, kill any lingering snap processes, refresh from the
        store (its tracked channel — not the catalog), then start it again.
        """
        from services import nimbus_store, container_snaps
        try:
            catalog = await nimbus_store.get_catalog()
            snap = nimbus_store.get_snap(catalog, snap_name)
            if snap is None:
                raise RuntimeError(f"App '{snap_name}' not found in nimbus store")
            channel = nimbus_store.get_channel(snap)
            if not channel:
                # No store channel — this snap was sideloaded and cannot be
                # refreshed from the store. Updating it means reinstalling.
                logger.warning(
                    "Skipping update for %s: not a store snap (no channel)", snap_name,
                )
                return
            store_name = nimbus_store.get_store_name(snap)
            service_name = nimbus_store.get_service_name(snap)

            # 1. Stop the user service (best effort).
            if service_name:
                try:
                    await container_snaps.service_action(service_name, "stop")
                    logger.info("Stopped %s before update", service_name)
                except Exception as exc:
                    logger.warning("Could not stop %s before update: %s", service_name, exc)

            # 2. Ensure every process from the snap mount is gone before refresh.
            await container_snaps.kill_snap_processes(store_name)

            # 3. Refresh from the store on the snap's tracked channel.
            logger.info("Updating %s via store refresh (channel=%s)", snap_name, channel)
            result = await container_snaps.refresh_container_snap(store_name, channel=channel)
            if not result.get("ok"):
                raise RuntimeError(f"Update failed: {result.get('stderr', '')}")
            logger.info("Store refresh completed for %s", snap_name)
            self._snap_updates.discard(store_name)

            # 4. Start the service again on the new revision.
            if service_name:
                try:
                    await container_snaps.service_action(service_name, "start")
                    logger.info("Started %s after update", service_name)
                except Exception as exc:
                    logger.warning("Could not start %s after update: %s", service_name, exc)
        except Exception as exc:
            logger.error("Update failed for %s: %s", snap_name, exc)
        finally:
            self._updating.discard(snap_name)

    async def request_install(self, app_id: str) -> dict:
        if settings.app_store_type == "nimbus":
            return await self._request_nimbus_install(app_id)
        from services import snap_store, container_snaps
        if snap_store.is_snap_catalog_app(app_id):
            return await self._request_snap_install(app_id)
        if store.get_app_meta(app_id) is None:
            raise HTTPException(status_code=404, detail=f"App '{app_id}' not found in store")
        if app_id in self._installing:
            return {"status": "already_installing"}
        installed = await self._call_manager(self.manager.installed_app_ids)
        if app_id in installed:
            return {"status": "already_installed"}
        asyncio.create_task(self._do_install(app_id))
        return {"status": "installing"}

    async def _request_snap_install(self, snap_name: str) -> dict:
        from services import snap_store, container_snaps
        if snap_name in self._installing:
            return {"status": "already_installing"}
        installed = await container_snaps.list_container_snaps()
        if any(s["name"] == snap_name for s in installed):
            return {"status": "already_installed"}
        ports = snap_store.get_snap_ports(snap_name)
        if ports:
            conflicts = await asyncio.to_thread(self.manager.get_conflicting_ports, snap_name, ports)
            if conflicts:
                conflict_ports = ", ".join(str(p) for p in conflicts)
                raise HTTPException(
                    status_code=409,
                    detail=f"Port(s) {conflict_ports} are already in use by another installed app",
                )
        self._installing.add(snap_name)
        asyncio.create_task(self._do_snap_install(snap_name))
        return {"status": "installing"}

    async def _do_snap_install(self, snap_name: str) -> None:
        from services import snap_store, container_snaps
        try:
            meta = await snap_store.fetch_snap_metadata(snap_name)
            classic = meta.get("confinement") == "classic"
            result = await container_snaps.install_container_snap(snap_name, classic=classic)
            if not result.get("ok"):
                raise RuntimeError(f"Snap install failed: {result.get('stderr', '')}")
            ports = snap_store.get_snap_ports(snap_name)
            if ports:
                await asyncio.to_thread(self.manager.setup_snap_port_proxies, snap_name, ports)
            logger.info("Snap install completed for %s", snap_name)
        except Exception as exc:
            logger.error("Snap install failed for %s: %s", snap_name, exc)
        finally:
            self._installing.discard(snap_name)

    async def _do_snap_update(self, snap_name: str) -> None:
        from services import container_snaps
        try:
            result = await container_snaps.refresh_container_snap(snap_name)
            if not result.get("ok"):
                logger.warning("Snap refresh returned error for %s: %s", snap_name, result.get("stderr", ""))
            else:
                logger.info("Snap refresh completed for %s", snap_name)
        except Exception as exc:
            logger.error("Snap update failed for %s: %s", snap_name, exc)
        finally:
            self._updating.discard(snap_name)

    async def request_update(self, app_id: str) -> dict:
        if settings.app_store_type == "nimbus":
            from services import nimbus_store
            catalog = await nimbus_store.get_catalog()
            if nimbus_store.get_snap(catalog, app_id) is None:
                raise HTTPException(status_code=404, detail=f"App '{app_id}' not found in nimbus store")
            if app_id in self._updating:
                return {"status": "already_updating"}
            self._updating.add(app_id)
            asyncio.create_task(self._do_nimbus_update(app_id))
            return {"status": "updating"}
        from services import snap_store
        if snap_store.is_snap_catalog_app(app_id):
            if app_id in self._updating:
                return {"status": "already_updating"}
            self._updating.add(app_id)
            asyncio.create_task(self._do_snap_update(app_id))
            return {"status": "updating"}
        installed = await self._call_manager(self.manager.installed_app_ids)
        if app_id not in installed:
            raise HTTPException(status_code=404, detail=f"App '{app_id}' is not installed")
        if app_id in self._updating:
            return {"status": "already_updating"}
        asyncio.create_task(self._do_update(app_id))
        return {"status": "updating"}

    async def uninstall_app(self, app_id: str) -> dict:
        if settings.app_store_type == "nimbus":
            return await self._uninstall_nimbus_snap(app_id)
        from services import snap_store
        if snap_store.is_snap_catalog_app(app_id):
            return await self._uninstall_snap(app_id)
        installed = await self._call_manager(self.manager.installed_app_ids)
        if app_id not in installed:
            raise HTTPException(status_code=404, detail=f"App '{app_id}' is not installed")
        await self._call_manager(self.manager.uninstall_app, app_id)
        return {"status": "uninstalled"}

    async def _uninstall_nimbus_snap(self, snap_name: str) -> dict:
        from services import nimbus_store, container_snaps
        catalog = await nimbus_store.get_catalog()
        snap = nimbus_store.get_snap(catalog, snap_name)
        if snap is None:
            raise HTTPException(status_code=404, detail=f"App '{snap_name}' not found in nimbus store")
        store_name = nimbus_store.get_store_name(snap)
        service_name = nimbus_store.get_service_name(snap)

        # The claw snaps run as a systemd user service snapd does not manage, so
        # tear it down before removing the snap: stop the service, kill any
        # lingering processes, then disable/remove the unit and daemon-reload.
        if service_name:
            try:
                await container_snaps.service_action(service_name, "stop")
            except Exception as exc:
                logger.warning("Could not stop %s before uninstall: %s", service_name, exc)
        await container_snaps.kill_snap_processes(store_name)
        if service_name:
            try:
                await container_snaps.remove_container_service(service_name)
            except Exception as exc:
                logger.warning("Could not remove user unit for %s: %s", service_name, exc)

        result = await container_snaps.remove_container_snap(store_name)
        if not result.get("ok"):
            raise HTTPException(status_code=500, detail=result.get("stderr", "remove failed"))
        self._snap_updates.discard(store_name)
        ports = snap.get("ports", [])
        if ports:
            try:
                await asyncio.to_thread(self.manager.teardown_snap_port_proxies, snap_name, ports)
            except Exception as exc:
                logger.warning("Could not tear down port proxies for '%s': %s", snap_name, exc)
        return {"status": "uninstalled"}

    async def _uninstall_snap(self, snap_name: str) -> dict:
        from services import snap_store, container_snaps
        result = await container_snaps.remove_container_snap(snap_name)
        if not result.get("ok"):
            raise HTTPException(status_code=500, detail=result.get("stderr", "remove failed"))
        ports = snap_store.get_snap_ports(snap_name)
        if ports:
            try:
                await asyncio.to_thread(self.manager.teardown_snap_port_proxies, snap_name, ports)
            except Exception as exc:
                logger.warning("Could not tear down port proxies for snap '%s': %s", snap_name, exc)
        return {"status": "uninstalled"}

    async def get_stats(self) -> SystemStats:
        from services.network import is_online
        info = await self._call_manager(self.manager.container_info)
        snapshot = await self._call_manager(self.manager.app_runtime_snapshot) if self._container_ready(info) else None
        app_count = len(snapshot.installed) if snapshot else 0
        online = await asyncio.to_thread(is_online)
        bootstrap_state = "waiting-for-network" if self._waiting_for_network else info.bootstrap_state
        from services.hardware import best_disk_path
        disk_path = best_disk_path()
        disk = psutil.disk_usage(disk_path)
        mem = psutil.virtual_memory()
        return _apply_device_stats(SystemStats(
            cpu_pct=psutil.cpu_percent(interval=0.1),
            mem_pct=mem.percent,
            mem_used_gb=round(mem.used / (1024 ** 3), 1),
            mem_total_gb=round(mem.total / (1024 ** 3), 1),
            disk_pct=disk.percent,
            disk_used_gb=round(disk.used / (1024 ** 3), 1),
            disk_total_gb=round(disk.total / (1024 ** 3), 1),
            app_count=app_count, control_mode="lxd",
            container_name=info.name, container_status=info.status,
            container_ip=info.ip_address, container_bootstrapped=info.bootstrapped,
            bootstrap_state=bootstrap_state, bootstrap_error=info.bootstrap_error,
            oobe_complete=is_oobe_complete(), online=online,
            appstore_visible=settings.appstore_visible,
            app_store_type=settings.app_store_type,
        ))

    async def get_ca_cert(self) -> tuple[bytes, str, str]:
        raise HTTPException(status_code=404, detail="CA certificate is not available in LXD controller mode")


# ---------------------------------------------------------------------------
# Lemonade auto-config helper
# ---------------------------------------------------------------------------


async def run_lemonade_autoconfig() -> None:
    """Re-run the lemonade --auto onboard command for every installed claw app.

    Called after the user switches the active AI model or changes the cloud
    offload policy. With Nimbus's always-on model_router collection, the model
    *name* each app is configured with never actually changes across these
    events (it's always model_provider.get_provider_config().model_id, the
    stable router collection name) — so this call's remaining job is letting
    apps that introspect model capabilities at onboard time (e.g. PicoClaw's
    context-window-based max_tokens tuning) re-run that tuning against the
    router's current definition. Must read the model id via
    model_provider.get_provider_config(), NOT lemonade.get_active_model_spec()
    directly — the latter would pass the raw local model name, which is wrong
    once claw apps are meant to always reference the stable collection name.
    """
    from services import container_snaps, nimbus_store
    logger.info("Re-running lemonade auto-config for all installed claw apps")
    active_model = model_provider.get_provider_config().model_id
    try:
        catalog, installed_snaps = await asyncio.gather(
            nimbus_store.get_catalog(),
            container_snaps.list_container_snaps(),
        )
    except Exception as exc:
        logger.error("run_lemonade_autoconfig: could not fetch catalog/snap list: %s", exc)
        return

    installed_names = {s.get("name") for s in installed_snaps}
    for snap in nimbus_store.get_snaps(catalog):
        if snap.get("name") not in installed_names:
            continue
        onboard = nimbus_store.get_onboard_cmd(snap)
        if not onboard:
            continue
        cmd, args = onboard
        args = list(args) + ["--model", active_model]
        snap_name = snap["name"]
        logger.info("Lemonade auto-config: %s → %s %s", snap_name, cmd, " ".join(args))
        try:
            result = await container_snaps.run_snap_cmd(cmd, args)
            if result.get("ok"):
                logger.info("Lemonade auto-config completed for %s", snap_name)
            else:
                logger.warning(
                    "Lemonade auto-config non-zero for %s | stdout: %s | stderr: %s",
                    snap_name,
                    result.get("stdout", "").strip(),
                    result.get("stderr", "").strip(),
                )
        except Exception as exc:
            logger.warning("Lemonade auto-config failed for %s (non-fatal): %s", snap_name, exc)


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


if settings.control_mode == "remote":
    if not settings.remote_base_url:
        raise ValueError("NIMBUS_REMOTE_BASE_URL is required when NIMBUS_CONTROL_MODE=remote")
    control_plane: ControlPlane = RemoteControlPlane(
        settings.remote_base_url,
        settings.remote_token,
    )
elif settings.control_mode == "lxd":
    control_plane = LxdControlPlane()
else:
    control_plane = LocalControlPlane()


def get_control_plane() -> ControlPlane:
    return control_plane
