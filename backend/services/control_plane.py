from __future__ import annotations

import asyncio
import logging
from typing import Protocol

import httpx
import psutil
from fastapi import HTTPException
from pylxd.exceptions import ClientConnectionFailed, LXDAPIException

from config import settings
from models import AppDetail, AppStatus, SystemStats
from services.device import get_device_manager, is_oobe_complete
from services import docker, network, store

logger = logging.getLogger(__name__)


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
        return None

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
        return [self._build_detail(m, s) for m, s in zip(metas, statuses)]

    async def get_app(self, app_id: str) -> AppDetail:
        meta = store.get_app_meta(app_id)
        if meta is None:
            raise HTTPException(status_code=404, detail=f"App '{app_id}' not found in store")
        status = await self._status_for(app_id, meta)
        return self._build_detail(meta, status)

    async def _do_install(self, app_id: str) -> None:
        self._installing.add(app_id)
        try:
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
        return await self._call_manager(self._list_apps_sync, host_ip)

    async def get_app(self, app_id: str) -> AppDetail:
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
