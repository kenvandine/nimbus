from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Protocol

import httpx
import psutil
from fastapi import HTTPException
from pylxd.exceptions import ClientConnectionFailed, LXDAPIException

from config import settings
from models import AppDetail, AppStatus, SystemStats
from services.device import get_device_manager, is_oobe_complete
from services import docker, lemonade, network, store, system_apps

logger = logging.getLogger(__name__)

_PRESSED_STATE = ".pressed_apps_state"


def _load_pressed_state(data_dir: Path) -> set[str]:
    try:
        return set(json.loads((data_dir / _PRESSED_STATE).read_text()))
    except Exception:
        return set()


def _save_pressed_state(data_dir: Path, queued: set[str]) -> None:
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        (data_dir / _PRESSED_STATE).write_text(json.dumps(sorted(queued)))
    except OSError as exc:
        logger.warning("Could not write pressed-apps state: %s", exc)


def _ensure_openclaw_workspace_link() -> None:
    """Expose the OpenClaw workspace dir to the file browser at
    <files_root>/openclaw-workspace.

    Local mode: create a symlink to <INSTALLED_DIR>/openclaw/data/data/
    .openclaw/workspace where the openclaw container writes.

    LXD mode: create a real directory. The LXD manager separately attaches
    that host directory as a bind-mount inside the LXC at the workspace
    path, so the file browser (host) and the openclaw container (inside
    docker, inside LXC) see the same files. The LXD-side device add lives
    in services/lxd.py because pylxd is required.
    """
    import os
    link = settings.files_root / "openclaw-workspace"
    try:
        link.parent.mkdir(parents=True, exist_ok=True)
        if settings.control_mode == "lxd":
            # Bind-mount source: must be a real directory the LXD daemon
            # can mount into the LXC. Replace any stale symlink.
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


async def _maybe_ensure_lemonade_model(cp: ControlPlane) -> None:
    """If openclaw is installed, fire the Lemonade model pre-pull in the
    background. ensure_default_model is idempotent — it skips the pull if
    the model is already registered, so this is a cheap safety net at
    every nimbus boot (covers cases where the install hook never ran:
    fresh container, manual cleanup, prior pull failure)."""
    try:
        apps = await cp.list_apps()
    except Exception as exc:
        logger.debug("Skipping lemonade ensure: %s", exc)
        return
    for app in apps:
        if app.id == "openclaw" and getattr(app, "installed", False):
            lemonade.ensure_default_model_task()
            return


async def _maybe_install_pressed_apps(cp: ControlPlane) -> None:
    """Queue installs for any pressed apps not yet seen on this device."""
    if not settings.pressed_apps:
        return
    data_dir = settings.installed_dir.parent
    already = _load_pressed_state(data_dir)
    new_apps = [a for a in settings.pressed_apps if a not in already]
    if not new_apps:
        return
    logger.info("Queuing install for new pressed apps: %s", new_apps)
    for app_id in new_apps:
        try:
            await cp.request_install(app_id)
        except Exception as exc:
            logger.warning("Failed to queue pressed app %s: %s", app_id, exc)
    _save_pressed_state(data_dir, already | set(new_apps))


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


async def _call_device_manager(func, *args):
    try:
        return await asyncio.to_thread(func, *args)
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _apply_device_stats(stats: SystemStats) -> SystemStats:
    device_status = get_device_manager().status()
    stats.device_management_available = device_status.actions_available
    stats.system_update_supported = device_status.system_update_supported
    stats.system_update_available = device_status.system_update_available
    stats.system_update_targets = device_status.system_update_targets
    stats.system_update_status = device_status.system_update_status
    stats.system_update_message = device_status.system_update_message
    stats.system_restart_required = device_status.system_restart_required
    return stats


class LocalControlPlane:
    def __init__(self) -> None:
        self._installing: set[str] = set()
        self._updating: set[str] = set()

    async def initialize(self) -> None:
        _ensure_openclaw_workspace_link()
        await _maybe_install_pressed_apps(self)
        await _maybe_ensure_lemonade_model(self)

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
            installed=True,
            running=running,
            port=port,
            open_url=open_url,
            update_available=update_available,
        )

    def _build_detail(self, meta, status: AppStatus) -> AppDetail:
        data = {**meta.model_dump(), **status.model_dump()}
        if status.installed and meta.deterministic_password:
            data["default_password"] = docker.get_app_password(meta.id)
        return AppDetail(**data)

    async def list_apps(self) -> list[AppDetail]:
        metas = store.list_apps()
        statuses = await asyncio.gather(*[self._status_for(m.id, m) for m in metas])
        host_ip = await network.get_host_ip()
        sys_apps = await system_apps.get_system_apps(host_ip)
        return sys_apps + [self._build_detail(m, s) for m, s in zip(metas, statuses)]

    async def get_app(self, app_id: str) -> AppDetail:
        if app_id == "lemonade":
            host_ip = await network.get_host_ip()
            return system_apps.get_lemonade_app(host_ip)
        meta = store.get_app_meta(app_id)
        if meta is None:
            raise HTTPException(status_code=404, detail=f"App '{app_id}' not found in store")
        status = await self._status_for(app_id, meta)
        return self._build_detail(meta, status)

    async def _do_install(self, app_id: str) -> None:
        self._installing.add(app_id)
        try:
            await docker.install_app(app_id)
            if app_id == "openclaw":
                # Pre-pull the OpenClaw default model on Lemonade in the
                # background so the install state isn't blocked on a
                # multi-GB download. Safe to fire-and-forget — the function
                # logs and skips if Lemonade isn't reachable.
                lemonade.ensure_default_model_task()
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

    async def active_installs(self) -> list[str]:
        return list(self._installing)

    async def get_stats(self) -> SystemStats:
        return _apply_device_stats(SystemStats(
            cpu_pct=psutil.cpu_percent(interval=0.1),
            mem_pct=psutil.virtual_memory().percent,
            disk_pct=psutil.disk_usage("/").percent,
            app_count=len(docker.installed_app_ids()),
            oobe_complete=True,
            online=True,
            appstore_visible=settings.appstore_visible,
        ))

    async def restart_system(self) -> dict:
        await _call_device_manager(get_device_manager().restart_system)
        return {"status": "restarting"}

    async def power_off_system(self) -> dict:
        await _call_device_manager(get_device_manager().power_off_system)
        return {"status": "powering_off"}

    async def _do_system_update(self, targets: list[str]) -> None:
        try:
            await asyncio.to_thread(get_device_manager().refresh_system, targets)
        except Exception as exc:
            logger.error("System update failed: %s", exc)

    async def update_system(self) -> dict:
        data = await _call_device_manager(get_device_manager().request_system_refresh)
        if data["status"] == "running":
            asyncio.create_task(self._do_system_update(list(data.get("targets", []))))
        return dict(data)

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


class RemoteControlPlane:
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
                method,
                f"{self.base_url}{path}",
                headers=self._headers(),
            )
        if response.is_error:
            raise HTTPException(status_code=response.status_code, detail=response.text)
        return response.json()

    async def _content(self, path: str) -> tuple[bytes, str, str]:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(
                f"{self.base_url}{path}",
                headers=self._headers(),
            )
        if response.is_error:
            raise HTTPException(status_code=response.status_code, detail=response.text)
        content_type = response.headers.get("content-type", "application/octet-stream")
        filename = "nimbus-ca.crt"
        return response.content, content_type, filename

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


class LxdControlPlane:
    def __init__(self) -> None:
        from services.lxd import get_lxd_manager

        self.manager = get_lxd_manager()
        self._installing: set[str] = set()
        self._updating: set[str] = set()
        self._bootstrap_task: asyncio.Task | None = None
        self._waiting_for_network: bool = False

    async def initialize(self) -> None:
        if settings.lxd_auto_bootstrap and self._bootstrap_task is None:
            self._bootstrap_task = asyncio.create_task(self._bootstrap_when_online())

    async def _bootstrap_when_online(self) -> None:
        from services.network import is_online
        if not await asyncio.to_thread(is_online):
            self._waiting_for_network = True
            logger.info("Waiting for network connectivity before LXD bootstrap…")
            while not await asyncio.to_thread(is_online):
                await asyncio.sleep(10)
            self._waiting_for_network = False
            logger.info("Network is up, starting LXD bootstrap")
        await asyncio.to_thread(self.manager.ensure_bootstrapped)
        _ensure_openclaw_workspace_link()
        await _maybe_install_pressed_apps(self)
        await _maybe_ensure_lemonade_model(self)

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
            info.exists
            and info.status == "running"
            and info.bootstrapped
            and info.bootstrap_state == "ready"
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
        if running:
            if not port:
                port = meta.port_hint if meta else None
        open_host = host_ip or info.ip_address
        open_url = network.build_open_url(open_host, port) if running and port and open_host else None

        installed_ver = str(app_state.get("version") or "")
        update_available = bool(meta and meta.version and installed_ver and installed_ver != meta.version)

        status = AppStatus(
            installed=True,
            running=running,
            port=port,
            open_url=open_url,
            update_available=update_available,
        )
        return status, str(app_state.get("password") or "")

    def _list_apps_sync(self, host_ip: str | None = None) -> list[AppDetail]:
        metas = store.list_apps()
        info = self.manager.container_info()
        snapshot = self.manager.app_runtime_snapshot() if self._container_ready(info) else None
        details: list[AppDetail] = []
        for meta in metas:
            status, default_password = self._status_for_sync(meta.id, meta, info, snapshot, host_ip)
            details.append(self._build_detail(meta, status, default_password))
        return details

    async def list_apps(self) -> list[AppDetail]:
        host_ip = await network.get_host_ip()
        store_apps = await self._call_manager(self._list_apps_sync, host_ip)
        sys = await system_apps.get_system_apps(host_ip)
        return sys + store_apps

    async def get_app(self, app_id: str) -> AppDetail:
        if app_id == "lemonade":
            host_ip = await network.get_host_ip()
            return system_apps.get_lemonade_app(host_ip)
        meta = store.get_app_meta(app_id)
        if meta is None:
            raise HTTPException(status_code=404, detail=f"App '{app_id}' not found in store")
        try:
            info = await self._call_manager(self.manager.container_info)
            snapshot = await self._call_manager(self.manager.app_runtime_snapshot) if self._container_ready(info) else None
            host_ip = await network.get_host_ip()
            status, default_password = await self._call_manager(
                self._status_for_sync,
                app_id,
                meta,
                info,
                snapshot,
                host_ip,
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
    ])

    @classmethod
    def _is_network_error(cls, exc: Exception) -> bool:
        msg = str(exc).lower()
        return any(hint in msg for hint in cls._NETWORK_ERROR_HINTS)

    async def _do_install(self, app_id: str) -> None:
        self._installing.add(app_id)
        logger.info("Starting install for %s", app_id)
        try:
            for attempt in range(1, 4):
                try:
                    await asyncio.to_thread(self.manager.install_app, app_id)
                    logger.info("Install completed for %s", app_id)
                    if app_id == "openclaw":
                        # Pre-pull the OpenClaw default model on Lemonade in
                        # the background so the user doesn't have to wait on
                        # a multi-GB download to use the wizard. Logs and
                        # skips on failure — see services/lemonade.py.
                        lemonade.ensure_default_model_task()
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

    async def request_install(self, app_id: str) -> dict:
        if store.get_app_meta(app_id) is None:
            raise HTTPException(status_code=404, detail=f"App '{app_id}' not found in store")
        if app_id in self._installing:
            return {"status": "already_installing"}
        installed = await self._call_manager(self.manager.installed_app_ids)
        if app_id in installed:
            return {"status": "already_installed"}
        asyncio.create_task(self._do_install(app_id))
        return {"status": "installing"}

    async def request_update(self, app_id: str) -> dict:
        installed = await self._call_manager(self.manager.installed_app_ids)
        if app_id not in installed:
            raise HTTPException(status_code=404, detail=f"App '{app_id}' is not installed")
        if app_id in self._updating:
            return {"status": "already_updating"}
        asyncio.create_task(self._do_update(app_id))
        return {"status": "updating"}

    async def uninstall_app(self, app_id: str) -> dict:
        installed = await self._call_manager(self.manager.installed_app_ids)
        if app_id not in installed:
            raise HTTPException(status_code=404, detail=f"App '{app_id}' is not installed")
        await self._call_manager(self.manager.uninstall_app, app_id)
        return {"status": "uninstalled"}

    async def active_installs(self) -> list[str]:
        return list(self._installing)

    async def get_stats(self) -> SystemStats:
        from services.network import is_online
        info = await self._call_manager(self.manager.container_info)
        snapshot = await self._call_manager(self.manager.app_runtime_snapshot) if self._container_ready(info) else None
        app_count = len(snapshot.installed) if snapshot else 0
        online = await asyncio.to_thread(is_online)
        bootstrap_state = "waiting-for-network" if self._waiting_for_network else info.bootstrap_state
        return _apply_device_stats(SystemStats(
            cpu_pct=psutil.cpu_percent(interval=0.1),
            mem_pct=psutil.virtual_memory().percent,
            disk_pct=psutil.disk_usage("/").percent,
            app_count=app_count,
            control_mode="lxd",
            container_name=info.name,
            container_status=info.status,
            container_ip=info.ip_address,
            container_bootstrapped=info.bootstrapped,
            bootstrap_state=bootstrap_state,
            bootstrap_error=info.bootstrap_error,
            oobe_complete=is_oobe_complete(),
            online=online,
            appstore_visible=settings.appstore_visible,
        ))

    async def restart_system(self) -> dict:
        await _call_device_manager(get_device_manager().restart_system)
        return {"status": "restarting"}

    async def power_off_system(self) -> dict:
        await _call_device_manager(get_device_manager().power_off_system)
        return {"status": "powering_off"}

    async def _do_system_update(self, targets: list[str]) -> None:
        try:
            await asyncio.to_thread(get_device_manager().refresh_system, targets)
        except Exception as exc:
            logger.error("System update failed: %s", exc)

    async def update_system(self) -> dict:
        data = await _call_device_manager(get_device_manager().request_system_refresh)
        if data["status"] == "running":
            asyncio.create_task(self._do_system_update(list(data.get("targets", []))))
        return dict(data)

    async def get_ca_cert(self) -> tuple[bytes, str, str]:
        raise HTTPException(status_code=404, detail="CA certificate is not available in LXD controller mode")


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
