from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from pylxd import Client
from pylxd.exceptions import ClientConnectionFailed, LXDAPIException, NotFound
from pylxd.models.network import Network
from pylxd.models.profile import Profile
from pylxd.models.storage_pool import StoragePool

from config import settings
from services import docker

logger = logging.getLogger(__name__)

CONTAINER_INSTALLED_DIR = Path("/var/lib/nimbus/installed")
CONTAINER_OVERLAY_DIR = Path("/opt/nimbus/openclaw-overlay")
# Where the openclaw container's workspace lives inside the LXC. The host
# snap bind-mounts <files_root>/openclaw-workspace to this path so the
# file browser and the agent see the same files.
CONTAINER_OPENCLAW_WORKSPACE = "/var/lib/nimbus/installed/openclaw/data/data/.openclaw/workspace"
BOOTSTRAP_MARKER = Path("/var/lib/nimbus/.agent-bootstrap-version")
BOOTSTRAP_VERSION = "1"
# Written into the pre-built image at build time to signal that APT packages
# are already installed and _install_runtime_packages can be skipped.
PACKAGES_MARKER = Path("/var/lib/nimbus/.packages-preinstalled")
# Written into the pre-built image to signal that /opt/nimbus-venv already
# contains all agent Python dependencies and _install_agent_python can be skipped.
AGENT_PYTHON_MARKER = Path("/var/lib/nimbus/.agent-python-preinstalled")
BACKEND_SOURCE_DIR = Path(__file__).resolve().parents[1]
SETUP_DIR = Path(__file__).resolve().parents[2] / "setup"
AGENT_SERVICE_SOURCE = SETUP_DIR / "nimbus.service"
LXC_AGENT_SERVICE_SOURCE = SETUP_DIR / "nimbus-lxc-agent.service"
LXC_AGENT_VERSION_MARKER = Path("/var/lib/nimbus/.lxc-agent-version")
LXC_AGENT_PORT = 9001
# Bump this whenever agent/daemon.py changes to trigger a re-deploy on next startup.
_LXC_AGENT_VERSION = "6"
DEFAULT_LXD_STORAGE_POOL = "default"
DEFAULT_LXD_PROFILE = "default"
DEFAULT_LXD_BRIDGE_PREFIX = "lxdbr"


@dataclass(frozen=True)
class ContainerInfo:
    name: str
    exists: bool
    status: str
    ip_address: str | None
    bootstrapped: bool
    bootstrap_state: str
    bootstrap_error: str | None


@dataclass(frozen=True)
class AppRuntimeSnapshot:
    installed: dict[str, dict[str, str | int | bool | None]]
    captured_at: float


class LxdManager:
    def __init__(self) -> None:
        self._local = threading.local()
        self._lock = threading.Lock()
        self._bootstrap_state = "idle"
        self._bootstrap_error: str | None = None
        self._snapshot_lock = threading.Lock()
        self._snapshot_cache: AppRuntimeSnapshot | None = None

    def _set_bootstrap_state(self, state: str, error: str | None = None) -> None:
        self._bootstrap_state = state
        self._bootstrap_error = error

    def _invalidate_snapshot(self) -> None:
        with self._snapshot_lock:
            self._snapshot_cache = None

    def _proxy_device_name(self, app_id: str) -> str:
        safe = re.sub(r"[^a-zA-Z0-9-]", "-", app_id)
        return f"nimbus-app-{safe}"

    # Single LXD proxy device that surfaces the host-side model service
    # (gemma4 / lemonade bound to 127.0.0.1) inside the nimbus LXC, where the
    # openclaw container can reach it via docker's host-gateway alias.
    _PROVIDER_PROXY_DEVICE_NAME = "nimbus-provider-fwd"
    # LXD proxy device that exposes the LXC agent daemon's HTTP API on the host.
    _LXC_AGENT_PROXY_DEVICE_NAME = "nimbus-lxc-agent"

    def _bootstrap_in_progress(self) -> bool:
        return self._bootstrap_state in {
            "ensuring-daemon",
            "ensuring-profile",
            "ensuring-container",
            "installing-runtime",
            "pushing-agent",
            "installing-agent-python",
            "starting-agent",
        }

    def _has_bootstrap_marker(self, instance) -> bool:
        marker = self._read_file(instance, str(BOOTSTRAP_MARKER))
        return bool(marker and marker.strip() == BOOTSTRAP_VERSION)

    def _has_packages_marker(self, instance) -> bool:
        return self._read_file(instance, str(PACKAGES_MARKER)) is not None

    def _has_agent_python_marker(self, instance) -> bool:
        return self._read_file(instance, str(AGENT_PYTHON_MARKER)) is not None

    def _import_seeded_image(self) -> None:
        """Import a pre-built LXC image tarball.

        Checks two locations in priority order:
          1. $SNAP_COMMON/lxc-seed/ — injected into the disk image at build time
             (deleted after import to reclaim space).
          2. $SNAP/lxc-seed/       — bundled inside the snap itself; read-only,
             so it stays in place after import (the alias check avoids re-import).

        No-ops silently when the tarball is absent in both locations.
        """
        snap_common = os.environ.get("SNAP_COMMON", "")
        snap = os.environ.get("SNAP", "")

        seed_path: Path | None = None
        for candidate in filter(None, [
            Path(snap_common) / "lxc-seed" / "nimbus-lxc-seed.tar.gz" if snap_common else None,
            Path(snap) / "lxc-seed" / "nimbus-lxc-seed.tar.gz" if snap else None,
        ]):
            if candidate.exists():
                seed_path = candidate
                break

        if seed_path is None:
            return

        alias = settings.lxd_local_image_alias or "nimbus-runtime"

        try:
            self.client().images.get_by_alias(alias)
            logger.info("Seeded LXC image already imported as '%s'", alias)
            if snap_common and str(seed_path).startswith(snap_common + os.sep):
                seed_path.unlink(missing_ok=True)
            return
        except NotFound:
            pass

        logger.info("Importing seeded LXC image from %s", seed_path)
        tmpdir = Path(tempfile.mkdtemp())
        try:
            with tarfile.open(seed_path) as tf:
                tf.extractall(tmpdir)

            unified_path = tmpdir / "image.tar.gz"   # unified export (newer LXD)
            meta_path    = tmpdir / "meta.tar.gz"    # split export — metadata half
            rootfs_path  = tmpdir / "rootfs"         # split export — rootfs half

            if unified_path.exists():
                logger.info("Seeded image is unified format")
                with open(unified_path, "rb") as f:
                    image = self.client().images.create(f.read(), wait=True)
            elif meta_path.exists() and rootfs_path.exists():
                logger.info("Seeded image is split format")
                with open(meta_path, "rb") as mf, open(rootfs_path, "rb") as rf:
                    image = self.client().images.create(rf.read(), metadata=mf.read(), wait=True)
            else:
                logger.error(
                    "Seeded LXC image is malformed (expected image.tar.gz or meta.tar.gz+rootfs): %s",
                    list(tmpdir.iterdir()),
                )
                return

            image.add_alias(alias, "Nimbus pre-built runtime")
            logger.info(
                "Seeded LXC image imported as '%s' (fingerprint: %s)",
                alias,
                image.fingerprint,
            )
            # Delete writable copies to reclaim disk space; $SNAP is read-only.
            if snap_common and str(seed_path).startswith(snap_common + os.sep):
                seed_path.unlink(missing_ok=True)
        except Exception as exc:
            logger.warning(
                "Failed to import seeded LXC image: %s — will pull from remote on next bootstrap",
                exc,
            )
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def client(self) -> Client:
        client = getattr(self._local, "client", None)
        if client is None:
            client = Client()
            self._local.client = client
        return client

    def _get_profile(self, name: str) -> Profile | None:
        try:
            return Profile.get(self.client(), name)
        except NotFound:
            return None

    def _profile_devices(self, profile: Profile | None) -> dict[str, dict[str, str]]:
        devices = getattr(profile, "devices", {}) if profile is not None else {}
        return {name: dict(config) for name, config in (devices or {}).items()}

    def _profile_has_nic(self, devices: dict[str, dict[str, str]]) -> bool:
        return any(device.get("type") == "nic" for device in devices.values())

    def _managed_networks(self) -> list[Network]:
        networks: list[Network] = []
        for network in self.client().networks.all():
            network.sync()
            if network.managed:
                networks.append(network)
        return networks

    def _next_bridge_name(self, existing_names: set[str]) -> str:
        idx = 0
        while True:
            name = f"{DEFAULT_LXD_BRIDGE_PREFIX}{idx}"
            if name in existing_names or Path("/sys/class/net", name).exists():
                idx += 1
                continue
            return name

    def _ensure_nm_ignores_lxd(self) -> None:
        """Write a NetworkManager drop-in that prevents NM from managing LXD
        bridge and veth interfaces.

        When NM tries DHCP on a veth it can't reach, it marks the interface
        failed and detaches it from lxdbr0 — breaking all container networking
        (both external DNS and host→container port forwarding).  This fix is
        idempotent and runs on every boot so it survives NM snap updates.
        """
        dropin_content = (
            "[keyfile]\n"
            "unmanaged-devices=interface-name:lxdbr*;interface-name:veth*\n"
        )
        # Try both the standard path (works on Ubuntu Server / with network-control
        # snap interface) and the NM snap's own data directory (Ubuntu Core).
        candidates = [
            Path("/etc/NetworkManager/conf.d/90-lxd-unmanaged.conf"),
            Path("/var/snap/network-manager/common/etc/NetworkManager/conf.d/90-lxd-unmanaged.conf"),
        ]
        wrote = False
        for dropin in candidates:
            try:
                dropin.parent.mkdir(parents=True, exist_ok=True)
                if not dropin.exists() or dropin.read_text() != dropin_content:
                    dropin.write_text(dropin_content)
                    logger.info("Wrote NM drop-in to prevent LXD interface management: %s", dropin)
                    wrote = True
            except OSError:
                pass  # Path not writable under this snap confinement; try next

        if wrote:
            # Restart NM so the new policy takes effect immediately.
            for cmd in (
                ["snap", "restart", "network-manager"],
                ["systemctl", "restart", "NetworkManager"],
            ):
                try:
                    result = subprocess.run(cmd, capture_output=True, timeout=30)
                    if result.returncode == 0:
                        logger.info("Restarted NetworkManager after drop-in update")
                        break
                except (FileNotFoundError, subprocess.TimeoutExpired):
                    pass

    def ensure_initialized(self) -> None:
        client = self.client()
        storage_pools = client.storage_pools.all()
        if storage_pools:
            return

        logger.info("Initializing LXD with Nimbus defaults")

        default_profile = self._get_profile(DEFAULT_LXD_PROFILE)
        profile_devices = self._profile_devices(default_profile)
        profile_devices["root"] = {
            "type": "disk",
            "path": "/",
            "pool": DEFAULT_LXD_STORAGE_POOL,
        }

        StoragePool.create(
            client,
            {
                "name": DEFAULT_LXD_STORAGE_POOL,
                "driver": "dir",
                "config": {},
            },
            wait=True,
        )

        managed_networks = self._managed_networks()
        if not managed_networks and not self._profile_has_nic(profile_devices):
            bridge_name = self._next_bridge_name({network.name for network in client.networks.all()})
            Network.create(
                client,
                bridge_name,
                description="Nimbus managed bridge",
                type="bridge",
                config={
                    "ipv4.address": "auto",
                    "ipv4.nat": "true",
                    "ipv6.address": "none",
                },
                wait=True,
            )
            profile_devices["eth0"] = {
                "type": "nic",
                "network": bridge_name,
                "name": "eth0",
            }

        if default_profile is None:
            Profile.create(
                client,
                DEFAULT_LXD_PROFILE,
                devices=profile_devices,
                description="Default LXD profile",
                wait=True,
            )
            return

        default_profile.devices = profile_devices
        default_profile.save(wait=True)

    def ensure_profile(self) -> None:
        client = self.client()
        description = "Nimbus nested-container hosting profile"
        config = {
            "security.nesting": "true",
            "security.syscalls.intercept.mknod": "true",
            "security.syscalls.intercept.setxattr": "true",
        }
        payload = {"description": description, "config": config, "devices": {}}

        try:
            response = client.api.profiles[settings.lxd_profile_name].get()
        except LXDAPIException as exc:
            if exc.response.status_code != 404:
                raise
            response = exc.response

        if response.status_code == 404:
            create_response = client.api.profiles.post(
                json={"name": settings.lxd_profile_name, **payload}
            )
            if create_response.status_code not in {200, 201, 202}:
                raise RuntimeError(f"Could not create LXD profile: {create_response.text}")
            return

        if response.status_code != 200:
            raise RuntimeError(f"Could not inspect LXD profile: {response.text}")

        metadata = response.json().get("metadata", {})
        if metadata.get("config") != config or metadata.get("description") != description:
            update_response = client.api.profiles[settings.lxd_profile_name].put(json=payload)
            if update_response.status_code not in {200, 202}:
                raise RuntimeError(f"Could not update LXD profile: {update_response.text}")

    def get_instance(self):
        client = self.client()
        if not client.instances.exists(settings.lxd_container_name):
            return None
        return client.instances.get(settings.lxd_container_name)

    def ensure_instance(self):
        instance = self.get_instance()
        if instance is not None:
            return instance
        errors: list[str] = []
        for source in self._image_source_candidates():
            config = {
                "name": settings.lxd_container_name,
                "type": "container",
                "profiles": ["default", settings.lxd_profile_name],
                "source": source,
            }
            try:
                logger.info(
                    "Creating LXD instance %s from %s:%s",
                    settings.lxd_container_name,
                    source.get("server"),
                    source.get("alias"),
                )
                return self.client().instances.create(config, wait=True)
            except LXDAPIException as exc:
                errors.append(f"{source.get('server')}:{source.get('alias')} -> {exc}")
                logger.warning(
                    "LXD image source failed for %s:%s: %s",
                    source.get("server"),
                    source.get("alias"),
                    exc,
                )
        raise RuntimeError("Could not create LXD instance from any configured image source:\n" + "\n".join(errors))

    def _image_source_candidates(self) -> list[dict[str, str]]:
        candidates: list[dict[str, str]] = []

        if settings.lxd_local_image_alias:
            candidates.append({"type": "image", "alias": settings.lxd_local_image_alias})

        aliases = self._image_alias_candidates(settings.lxd_image_alias)
        seen: set[tuple[str, str, str]] = set()

        def add(server: str, protocol: str, alias: str) -> None:
            key = (server, protocol, alias)
            if key in seen:
                return
            seen.add(key)
            candidates.append(
                {
                    "type": "image",
                    "mode": "pull",
                    "server": server,
                    "protocol": protocol,
                    "alias": alias,
                }
            )

        for alias in aliases:
            add(settings.lxd_image_server, settings.lxd_image_protocol, alias)

        for alias in aliases:
            add("https://cloud-images.ubuntu.com/releases", "simplestreams", alias)

        for alias in self._image_alias_candidates("24.04"):
            add("https://cloud-images.ubuntu.com/releases", "simplestreams", alias)

        return candidates

    def _image_alias_candidates(self, alias: str) -> list[str]:
        normalized = alias.strip()
        candidates: list[str] = []

        def add(value: str) -> None:
            value = value.strip()
            if value and value not in candidates:
                candidates.append(value)

        add(normalized)
        if normalized.startswith("ubuntu:"):
            add(normalized.split(":", 1)[1])
        if normalized.startswith("ubuntu/"):
            add(normalized.split("/", 1)[1])
        if normalized == "24.04":
            add("noble")
        if normalized in {"ubuntu/24.04", "ubuntu:24.04"}:
            add("24.04")
            add("noble")
        return candidates

    def ensure_started(self):
        instance = self.ensure_instance()
        for attempt in range(10):
            status = getattr(instance, "status", "").lower()
            if status == "running":
                return instance
            try:
                instance.start(wait=True)
                return instance
            except LXDAPIException as exc:
                # LXD serialises operations per instance. A freshly-created or
                # recently-saved instance may still have a "create"/"update"
                # operation in flight; back off and retry rather than failing
                # the whole bootstrap.
                if "busy" in str(exc).lower() and attempt < 9:
                    logger.warning(
                        "LXD instance %s busy (attempt %d/10), retrying in 5s: %s",
                        settings.lxd_container_name, attempt + 1, exc,
                    )
                    time.sleep(5)
                    instance.sync()
                    continue
                raise
        return instance

    def _instance_devices(self, instance) -> dict:
        instance.sync()
        return dict(getattr(instance, "devices", {}) or {})

    def _save_instance_devices(self, instance, devices: dict) -> None:
        instance.devices = devices
        instance.save(wait=True)

    def _app_proxy_device(self, port: int) -> dict[str, str]:
        return {
            "type": "proxy",
            "bind": "host",
            "listen": f"tcp:{settings.lxd_publish_host}:{port}",
            "connect": f"tcp:127.0.0.1:{port}",
        }

    def _provider_proxy_device(self, port: int) -> dict[str, str]:
        # bind=container: listener runs in the LXC's netns (visible on docker
        # bridge too); connector runs in the host's netns so it reaches the
        # model snap's 127.0.0.1 listener.
        return {
            "type": "proxy",
            "bind": "container",
            "listen": f"tcp:0.0.0.0:{port}",
            "connect": f"tcp:127.0.0.1:{port}",
        }

    def _configure_provider_proxy(self, instance) -> None:
        """Sync the host-loopback bridge device against the current openai-url.
        Adds / updates the device when the URL points at a loopback port, and
        removes it otherwise (e.g. operator pointed at an off-host server)."""
        from services import model_provider
        devices = self._instance_devices(instance)
        name = self._PROVIDER_PROXY_DEVICE_NAME
        port = model_provider.loopback_listen_port()
        if not port:
            if name in devices:
                devices.pop(name, None)
                self._save_instance_devices(instance, devices)
            return
        desired = self._provider_proxy_device(port)
        if devices.get(name) == desired:
            return
        devices[name] = desired
        self._save_instance_devices(instance, devices)

    def _configure_app_proxy(self, instance, app_id: str, port: int | None) -> None:
        devices = self._instance_devices(instance)
        name = self._proxy_device_name(app_id)

        if not port:
            if name in devices:
                devices.pop(name, None)
                self._save_instance_devices(instance, devices)
            return

        desired = self._app_proxy_device(port)
        if devices.get(name) == desired:
            return

        devices[name] = desired
        self._save_instance_devices(instance, devices)

    def _reconcile_app_proxies(self, instance, installed: dict[str, dict[str, str | int | bool | None]]) -> None:
        devices = self._instance_devices(instance)
        changed = False

        for app_id, data in installed.items():
            port = data.get("port")
            if not isinstance(port, int):
                continue
            name = self._proxy_device_name(app_id)
            desired = self._app_proxy_device(port)
            if devices.get(name) != desired:
                devices[name] = desired
                changed = True

        if changed:
            self._save_instance_devices(instance, devices)

    def _run(
        self,
        instance,
        command: list[str],
        *,
        acceptable: set[int] | None = None,
        environment: dict[str, str] | None = None,
        cwd: str | None = None,
    ) -> tuple[int, str, str]:
        acceptable = acceptable or {0}
        exit_code, stdout, stderr = instance.execute(
            command,
            environment=environment,
            cwd=cwd,
        )
        if exit_code not in acceptable:
            raise RuntimeError(
                f"Command failed in {settings.lxd_container_name}: {' '.join(command)}\n{stderr or stdout}"
            )
        return exit_code, stdout, stderr

    def _wait_for_container_dns(self, instance, timeout: int = 120) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            code, _, _ = self._run(
                instance, ["getent", "hosts", "github.com"], acceptable={0, 1, 2}
            )
            if code == 0:
                return
            time.sleep(5)
        logger.warning("DNS did not become ready inside the container within %ds, proceeding anyway", timeout)

    def _wait_for_docker(self, instance, timeout: int = 180) -> None:
        """Wait for the Docker daemon to be ready inside the container.

        After a reboot the LXC reaches 'running' before Docker has finished
        starting as a systemd service. Polling 'docker info' avoids declaring
        bootstrap_state='ready' prematurely, which would leave the UI stuck on
        'Waiting for the OpenClaw agent to come online' for the entire Docker
        startup duration (typically 1-3 minutes).
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            code, _, _ = self._run(instance, ["docker", "info"], acceptable={0, 1})
            if code == 0:
                return
            time.sleep(5)
        logger.warning("Docker did not become ready inside the container within %ds, proceeding anyway", timeout)

    def _file_exists(self, instance, path: str) -> bool:
        exit_code, _, _ = self._run(
            instance,
            [
                "python3",
                "-c",
                "from pathlib import Path; import sys; sys.exit(0 if Path(sys.argv[1]).exists() else 1)",
                path,
            ],
            acceptable={0, 1},
        )
        return exit_code == 0

    def _read_file(self, instance, path: str) -> str | None:
        try:
            data = instance.files.get(path)
        except LXDAPIException as exc:
            if getattr(exc, "response", None) is not None and exc.response.status_code == 404:
                return None
            raise
        except FileNotFoundError:
            return None
        return data.decode() if isinstance(data, bytes) else str(data)

    def _write_file(
        self,
        instance,
        path: str,
        content: str,
        *,
        mode: int = 0o644,
    ) -> None:
        parent = str(Path(path).parent)
        self._run(instance, ["mkdir", "-p", parent])
        instance.files.put(path, content, mode=mode)

    def _container_ip(self, instance) -> str | None:
        if getattr(instance, "status", "").lower() != "running":
            return None
        state = instance.state()
        network = getattr(state, "network", {}) or {}
        for iface_name, iface in network.items():
            if iface_name != settings.primary_interface:
                continue
            for address in iface.get("addresses", []):
                if address.get("family") == "inet" and address.get("scope") == "global":
                    return address.get("address")
        for iface in network.values():
            for address in iface.get("addresses", []):
                if address.get("family") == "inet" and address.get("scope") == "global":
                    return address.get("address")
        return None

    def _agent_env(self) -> str:
        lines = [
            "NIMBUS_CONTROL_MODE=local",
            f"NIMBUS_BIND_HOST={settings.lxd_agent_bind_host}",
            f"NIMBUS_PORT={settings.lxd_agent_port}",
            "NIMBUS_SERVE_FRONTEND=false",
            "NIMBUS_REFRESH_STORE_ON_STARTUP=true",
            "NIMBUS_STORE_DIR=/var/lib/nimbus/store",
            "NIMBUS_INSTALLED_DIR=/var/lib/nimbus/installed",
            f"NIMBUS_MODEL_PROVIDER={settings.model_provider}",
            f"NIMBUS_OPENAI_URL={settings.openai_url}",
        ]
        if settings.lxd_agent_token:
            lines.append(f"NIMBUS_API_TOKEN={settings.lxd_agent_token}")
        return "\n".join(lines) + "\n"

    def _configure_openclaw_ws_proxy(self, instance) -> None:
        """Set up a separate LXD proxy for OpenClaw's gateway WS API port."""
        from services.openclaw import OPENCLAW_PORT
        devices = self._instance_devices(instance)
        name = f"{self._proxy_device_name('openclaw')}-ws"
        desired = self._app_proxy_device(OPENCLAW_PORT)
        if devices.get(name) == desired:
            return
        devices[name] = desired
        self._save_instance_devices(instance, devices)

    def _configure_lxc_agent_proxy(self, instance) -> None:
        devices = self._instance_devices(instance)
        name = self._LXC_AGENT_PROXY_DEVICE_NAME
        desired = {
            "type": "proxy",
            "bind": "host",
            "listen": f"tcp:{settings.lxd_publish_host}:{LXC_AGENT_PORT}",
            "connect": f"tcp:127.0.0.1:{LXC_AGENT_PORT}",
        }
        if devices.get(name) == desired:
            return
        devices[name] = desired
        self._save_instance_devices(instance, devices)

    def _ensure_lxc_agent(self, instance) -> None:
        """Push the LXC agent daemon and (re)start it if the version changed."""
        current = self._read_file(instance, str(LXC_AGENT_VERSION_MARKER))
        if current and current.strip() == _LXC_AGENT_VERSION:
            return

        logger.info("Installing LXC agent daemon v%s", _LXC_AGENT_VERSION)
        agent_src = BACKEND_SOURCE_DIR / "agent"
        if not agent_src.exists():
            logger.warning("LXC agent source not found at %s — skipping", agent_src)
            return

        self._run(instance, ["mkdir", "-p", "/opt/nimbus/backend/agent"])
        instance.files.recursive_put(str(agent_src), "/opt/nimbus/backend/agent")
        self._write_file(
            instance,
            "/etc/systemd/system/nimbus-lxc-agent.service",
            LXC_AGENT_SERVICE_SOURCE.read_text(),
        )
        self._run(instance, ["systemctl", "daemon-reload"])
        self._run(instance, ["systemctl", "enable", "nimbus-lxc-agent"])
        self._run(instance, ["systemctl", "restart", "nimbus-lxc-agent"], acceptable={0, 1})
        self._write_file(instance, str(LXC_AGENT_VERSION_MARKER), _LXC_AGENT_VERSION + "\n")
        self._configure_lxc_agent_proxy(instance)
        logger.info("LXC agent daemon installed and started")

    def _push_agent_payload(self, instance) -> None:
        self._run(instance, ["mkdir", "-p", "/opt/nimbus", "/var/lib/nimbus/store", "/var/lib/nimbus/installed"])
        instance.files.recursive_put(str(BACKEND_SOURCE_DIR), "/opt/nimbus/backend")
        self._write_file(instance, "/etc/systemd/system/nimbus.service", AGENT_SERVICE_SOURCE.read_text())
        self._write_file(instance, "/etc/default/nimbus", self._agent_env(), mode=0o600)

    def _install_runtime_packages(self, instance) -> None:
        env = {"DEBIAN_FRONTEND": "noninteractive"}
        self._run(instance, ["apt-get", "update", "-q"], environment=env)
        self._run(
            instance,
            [
                "apt-get",
                "install",
                "-y",
                "-q",
                "docker.io",
                "docker-compose-v2",
                "python3",
                "python3-venv",
                "git",
                "curl",
                "ca-certificates",
            ],
            environment=env,
        )
        self._run(instance, ["mkdir", "-p", "/var/lib/nimbus/data/storage"])
        self._run(instance, ["chmod", "777", "/var/lib/nimbus/data/storage"])

    def _install_agent_python(self, instance) -> None:
        self._run(instance, ["python3", "-m", "venv", "/opt/nimbus-venv"])
        self._run(instance, ["/opt/nimbus-venv/bin/pip", "install", "--upgrade", "pip"])
        self._run(instance, ["/opt/nimbus-venv/bin/pip", "install", "-r", "/opt/nimbus/backend/requirements.txt"])

    def _enable_services(self, instance) -> None:
        # Write Docker DNS config unconditionally so it takes effect whether
        # packages were just installed or came pre-built in the seeded image
        # (which skips _install_runtime_packages).  Without this, Docker falls
        # back to the LXC's 127.0.0.53 systemd-resolved stub, which returns
        # SERVFAIL for registry-1.docker.io and breaks all image pulls.
        self._run(instance, ["mkdir", "-p", "/etc/docker"])
        self._write_file(
            instance,
            "/etc/docker/daemon.json",
            '{"dns": ["1.1.1.1", "8.8.8.8"]}\n',
        )
        self._run(instance, ["systemctl", "restart", "docker"])
        self._run(instance, ["systemctl", "enable", "docker"])
        self._run(instance, ["systemctl", "daemon-reload"])
        self._run(instance, ["systemctl", "enable", "nimbus"])
        self._run(instance, ["systemctl", "restart", "nimbus"])

    def ensure_bootstrapped(self) -> None:
        with self._lock:
            try:
                self._set_bootstrap_state("ensuring-daemon")
                self._ensure_nm_ignores_lxd()
                self.ensure_initialized()
                self._set_bootstrap_state("ensuring-profile")
                self.ensure_profile()
                self._set_bootstrap_state("importing-image")
                self._import_seeded_image()
                self._set_bootstrap_state("ensuring-container")
                instance = self.ensure_started()
                if self._has_bootstrap_marker(instance):
                    self._set_bootstrap_state("starting-agent")
                    self._wait_for_docker(instance)
                    self._repatch_provider_apps(instance)
                    self._ensure_lxc_agent(instance)
                    self._set_bootstrap_state("ready")
                    return

                self._set_bootstrap_state("installing-runtime")
                packages_preinstalled = self._has_packages_marker(instance)
                agent_python_preinstalled = self._has_agent_python_marker(instance)
                if packages_preinstalled and agent_python_preinstalled:
                    logger.info("Packages and Python env preinstalled — skipping network-dependent setup")
                else:
                    self._wait_for_container_dns(instance)
                    if not packages_preinstalled:
                        self._install_runtime_packages(instance)
                    else:
                        logger.info("Packages already preinstalled — skipping APT install")
                self._set_bootstrap_state("pushing-agent")
                self._push_agent_payload(instance)
                self._set_bootstrap_state("installing-agent-python")
                if not agent_python_preinstalled:
                    self._install_agent_python(instance)
                else:
                    logger.info("Python env already preinstalled — skipping venv/pip setup")
                self._set_bootstrap_state("starting-agent")
                self._enable_services(instance)
                self._ensure_lxc_agent(instance)
                self._write_file(instance, str(BOOTSTRAP_MARKER), BOOTSTRAP_VERSION + "\n")
                self._set_bootstrap_state("ready")
            except (ClientConnectionFailed, LXDAPIException, RuntimeError) as exc:
                self._set_bootstrap_state("error", str(exc))
                raise

    def container_info(self) -> ContainerInfo:
        try:
            instance = self.get_instance()
        except (ClientConnectionFailed, LXDAPIException) as exc:
            return ContainerInfo(
                name=settings.lxd_container_name,
                exists=False,
                status="unavailable",
                ip_address=None,
                bootstrapped=False,
                bootstrap_state=self._bootstrap_state,
                bootstrap_error=str(exc),
            )

        if instance is None:
            return ContainerInfo(
                name=settings.lxd_container_name,
                exists=False,
                status="missing",
                ip_address=None,
                bootstrapped=False,
                bootstrap_state=self._bootstrap_state,
                bootstrap_error=self._bootstrap_error,
            )

        status = getattr(instance, "status", "unknown").lower()
        bootstrapped = False
        if status == "running":
            bootstrapped = self._has_bootstrap_marker(instance)

        return ContainerInfo(
            name=settings.lxd_container_name,
            exists=True,
            status=status,
            ip_address=self._container_ip(instance),
            bootstrapped=bootstrapped,
            bootstrap_state=self._bootstrap_state,
            bootstrap_error=self._bootstrap_error,
        )

    def installed_app_ids(self) -> list[str]:
        return sorted(self.app_runtime_snapshot().installed.keys())

    def app_runtime_snapshot(self, ttl_seconds: float = 2.0) -> AppRuntimeSnapshot:
        with self._snapshot_lock:
            cached = self._snapshot_cache
            now = time.monotonic()
            if cached and now - cached.captured_at <= ttl_seconds:
                return cached

        instance = self.ensure_started()
        _, stdout, _ = self._run(
            instance,
            [
                "python3",
                "-c",
                """
import json
import pathlib
import re
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
apps = {}
port_re = re.compile(r'(?:0\\.0\\.0\\.0|\\[::\\]):(\\d+)->\\d+/(?:tcp|udp)')

if root.exists():
    for d in sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name):
        env_path = d / '.env'
        version_path = d / '.nimbus-version'
        password = ''
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if line.startswith('APP_PASSWORD='):
                    password = line.split('=', 1)[1]
                    break
        version = version_path.read_text().strip() if version_path.exists() else ''
        apps[d.name] = {'version': version, 'password': password, 'running': False, 'port': None}

fmt = '{{.Label "com.docker.compose.project"}}\\t{{.Ports}}'
proc = subprocess.run(['docker', 'ps', '--format', fmt], capture_output=True, text=True)
if proc.returncode == 0:
    for line in proc.stdout.splitlines():
        if '\\t' not in line:
            continue
        app_id, ports = line.split('\\t', 1)
        if app_id not in apps:
            continue
        apps[app_id]['running'] = True
        matches = [int(p) for p in port_re.findall(ports)]
        if matches:
            current = apps[app_id]['port']
            apps[app_id]['port'] = min(matches) if current is None else min(current, min(matches))

print(json.dumps(apps), end='')
""",
                str(CONTAINER_INSTALLED_DIR),
            ],
        )
        snapshot = AppRuntimeSnapshot(
            installed=json.loads(stdout or "{}"),
            captured_at=time.monotonic(),
        )
        self._reconcile_app_proxies(instance, snapshot.installed)
        self._configure_provider_proxy(instance)
        with self._snapshot_lock:
            self._snapshot_cache = snapshot
        return snapshot

    def get_installed_version(self, app_id: str) -> str | None:
        data = self.app_runtime_snapshot().installed.get(app_id)
        version = data.get("version") if data else None
        return str(version) if version else None

    def get_app_password(self, app_id: str) -> str:
        data = self.app_runtime_snapshot().installed.get(app_id)
        password = data.get("password") if data else ""
        return str(password) if password else ""

    def get_env_text(self, app_id: str) -> str | None:
        instance = self.ensure_started()
        return self._read_file(instance, f"{CONTAINER_INSTALLED_DIR / app_id / '.env'}")

    def is_running(self, app_id: str) -> bool:
        data = self.app_runtime_snapshot().installed.get(app_id)
        return bool(data and data.get("running"))

    def get_web_port(self, app_id: str) -> int | None:
        data = self.app_runtime_snapshot().installed.get(app_id)
        port = data.get("port") if data else None
        return int(port) if isinstance(port, int) else None

    def _ensure_openclaw_workspace_device(self, instance) -> None:
        """Bind-mount <files_root>/openclaw-workspace from the host into the
        LXC at the openclaw workspace path. Lets the host snap's file
        browser show files written by the openclaw agent. Idempotent."""
        src = settings.files_root / "openclaw-workspace"
        try:
            src.mkdir(parents=True, exist_ok=True)
            try:
                os.chmod(src, 0o777)
            except OSError:
                pass
        except OSError as exc:
            logger.warning("Could not prepare openclaw-workspace bind source %s: %s", src, exc)
            return

        # Ensure the parent path exists inside the LXC so LXD can attach,
        # and that it's writable by the openclaw container (uid 1000) — we
        # are creating .openclaw/ here as LXC-root, so without the chown
        # the container can't write openclaw.json into it.
        parent = str(Path(CONTAINER_OPENCLAW_WORKSPACE).parent)
        self._run(instance, ["mkdir", "-p", parent])
        self._run(instance, ["chown", "1000:1000", parent])
        self._run(instance, ["chmod", "775", parent])

        devname = "openclaw-workspace"
        desired = {
            "type": "disk",
            "source": str(src),
            "path": CONTAINER_OPENCLAW_WORKSPACE,
            # Idmapped mount so files written by the openclaw container
            # (uid 1000 inside docker) appear with the right ownership on
            # the host snap side too. Requires kernel idmap support.
            "shift": "true",
        }
        current = dict(instance.devices.get(devname) or {})
        if current == desired:
            return
        instance.devices[devname] = desired
        try:
            instance.save(wait=True)
            logger.info("Attached openclaw-workspace bind: host %s -> lxc %s", src, CONTAINER_OPENCLAW_WORKSPACE)
        except LXDAPIException as exc:
            # Fall back to no-shift if the kernel/storage backend rejects it.
            if "shift" in str(exc).lower():
                logger.warning("LXD rejected shift=true; retrying without it")
                desired.pop("shift")
                instance.devices[devname] = desired
                instance.save(wait=True)
            else:
                raise

    def _push_openclaw_overlay(self, instance) -> None:
        """Push nimbus's openclaw-overlay/ from the host snap into the LXC
        container at CONTAINER_OVERLAY_DIR. Done before docker compose up so
        the bind-mount source is visible to dockerd inside the container."""
        src = settings.overlay_dir / "openclaw-overlay"
        if not src.exists():
            logger.warning(
                "openclaw overlay missing at %s — installing without Lemonade preselection",
                src,
            )
            return
        self._run(instance, ["mkdir", "-p", str(CONTAINER_OVERLAY_DIR)])
        instance.files.recursive_put(str(src), str(CONTAINER_OVERLAY_DIR))

    def _prepare_volume_paths(self, instance, bundle: docker.PreparedAppBundle) -> None:
        self._run(instance, ["mkdir", "-p", str(bundle.app_dir), str(bundle.data_dir)])
        self._run(instance, ["chmod", "777", str(bundle.data_dir)])
        for spec in bundle.volume_paths:
            parent = str(Path(spec.path).parent)
            self._run(instance, ["mkdir", "-p", parent])
            if spec.is_file:
                self._run(instance, ["touch", spec.path])
            else:
                self._run(instance, ["mkdir", "-p", spec.path])
            self._run(instance, ["chmod", format(spec.mode, "o"), spec.path])
            if spec.uid >= 0:
                self._run(instance, ["chown", f"{spec.uid}:{spec.gid}", spec.path])

    def _to_container_url(self, host_url: str) -> str:
        """Rewrite a host-loopback URL to one reachable from inside docker-in-LXC."""
        return host_url.replace("localhost", "host.docker.internal").replace(
            "127.0.0.1", "host.docker.internal"
        )

    def _configure_hermes_provider(self, instance, data_dir: Path) -> None:
        """Pre-write hermes data files so the gateway starts with the
        configured LLM backend on first boot.

        Hermes resolves the provider via auth.json (active_provider) before
        falling back to env-var auto-detection.  We use the built-in 'lmstudio'
        provider (openai_chat transport, reads LM_BASE_URL/LM_API_KEY) rather
        than 'openai-api' (codex_responses transport) so standard chat-
        completions endpoints like lemonade are fully compatible.
        """
        import json as _json
        from services.model_provider import get_provider_config
        cfg = get_provider_config()
        container_base = self._to_container_url(cfg.base_url)
        hermes_dir = str(data_dir / "data" / "hermes")
        self._run(instance, ["mkdir", "-p", hermes_dir])
        self._run(instance, ["chmod", "777", hermes_dir])
        # Write LM Studio env vars to hermes .env so they survive container
        # restarts even if the docker-compose environment changes.
        env_content = (
            f"LM_BASE_URL={container_base}\n"
            "LM_API_KEY=nimbus-local\n"
            f"HERMES_MODEL={cfg.model_id}\n"
        )
        self._write_file(instance, f"{hermes_dir}/.env", env_content, mode=0o600)
        # auth.json: set active_provider so resolve_provider() returns "lmstudio"
        # before it can fall through to the OPENAI_API_KEY → "openrouter" path.
        auth_store = {
            "version": 1,
            "providers": {},
            "active_provider": "lmstudio",
        }
        self._write_file(
            instance,
            f"{hermes_dir}/auth.json",
            _json.dumps(auth_store, indent=2) + "\n",
            mode=0o600,
        )
        # config.yaml: default model so the user doesn't need to run hermes setup.
        config_content = (
            f"model: lmstudio/{cfg.model_id}\n"
            "skills:\n"
            "  external_dirs:\n"
            "    - /app/umbrel-context/skills\n"
            "plugins:\n"
            "  enabled:\n"
            "    - umbrel-runtime\n"
        )
        self._write_file(instance, f"{hermes_dir}/config.yaml", config_content)
        # Hermes runs as uid 1000; LXD file writes land as root.
        self._run(instance, ["chown", "1000:1000",
                              f"{hermes_dir}/.env",
                              f"{hermes_dir}/auth.json",
                              f"{hermes_dir}/config.yaml"])

    def _configure_picoclaw_provider(self, instance, data_dir: Path) -> None:
        """Pre-write picoclaw config.json so it boots with the configured LLM backend."""
        import json
        from services.model_provider import get_provider_config
        cfg = get_provider_config()
        container_base = self._to_container_url(cfg.base_url)
        picoclaw_dir = str(data_dir / "data")
        self._run(instance, ["mkdir", "-p", picoclaw_dir])
        self._run(instance, ["chmod", "777", picoclaw_dir])
        config = {
            "model_list": [
                {
                    "model_name": "lemonade",
                    "provider": "openai",
                    "model": cfg.model_id,
                    "api_base": container_base,
                }
            ],
            "agents": {
                "defaults": {
                    "provider": "openai",
                    "model_name": "lemonade",
                }
            },
        }
        self._write_file(
            instance,
            f"{picoclaw_dir}/config.json",
            json.dumps(config, indent=2) + "\n",
        )
        # Picoclaw runs as uid 1000; LXD file writes land as root.
        self._run(instance, ["chown", "1000:1000", f"{picoclaw_dir}/config.json"])

    def _repatch_provider_apps(self, instance) -> None:
        """Re-apply model-provider configuration to installed provider-aware apps.

        Called at each container startup so a snap update propagates new
        provider configuration without requiring the user to reinstall the app.
        """
        # Apps configured via compose env var injection
        compose_checks = {
            "openclaw": "NIMBUS_OPENCLAW_BASE_URL",
            "anything-llm": "GENERIC_OPEN_AI_BASE_PATH",
        }
        for app_id, marker in compose_checks.items():
            env_file = str(CONTAINER_INSTALLED_DIR / app_id / ".env")
            compose_file = str(CONTAINER_INSTALLED_DIR / app_id / "docker-compose.yml")
            env_text = self._read_file(instance, env_file)
            if not env_text:
                continue
            existing = self._read_file(instance, compose_file) or ""
            if marker in existing:
                continue
            logger.info("Repatching provider overlay for %s", app_id)
            try:
                if app_id == "openclaw":
                    self._push_openclaw_overlay(instance)
                    self._configure_openclaw_ws_proxy(instance)
                self._configure_provider_proxy(instance)
                bundle = docker.build_app_bundle(
                    app_id,
                    installed_dir=CONTAINER_INSTALLED_DIR,
                    env_text=env_text,
                    overlay_dir=CONTAINER_OVERLAY_DIR,
                )
                self._write_file(instance, compose_file, bundle.compose_text)
                self._run(
                    instance,
                    [
                        "docker", "compose", "-p", app_id,
                        "-f", compose_file, "--env-file", env_file,
                        "up", "-d", "--remove-orphans",
                    ],
                    acceptable={0, 1},
                )
            except Exception as exc:
                logger.warning("Failed to repatch %s: %s", app_id, exc)

        # Apps configured via data files (compose env vars are insufficient)
        for app_id in ("hermes-agent", "picoclaw"):
            env_file = str(CONTAINER_INSTALLED_DIR / app_id / ".env")
            env_text = self._read_file(instance, env_file)
            if not env_text:
                continue
            data_dir = CONTAINER_INSTALLED_DIR / app_id / "data"
            needs_restart = False
            try:
                if app_id == "hermes-agent":
                    hermes_auth = self._read_file(instance, str(data_dir / "data" / "hermes" / "auth.json")) or ""
                    if "lmstudio" not in hermes_auth:
                        logger.info("Writing hermes provider data files")
                        self._configure_provider_proxy(instance)
                        self._configure_hermes_provider(instance, data_dir)
                        needs_restart = True
                elif app_id == "picoclaw":
                    picoclaw_cfg = self._read_file(instance, str(data_dir / "data" / "config.json")) or ""
                    if "lemonade" not in picoclaw_cfg:
                        logger.info("Writing picoclaw provider config")
                        self._configure_provider_proxy(instance)
                        self._configure_picoclaw_provider(instance, data_dir)
                        needs_restart = True
                if needs_restart:
                    compose_file = str(CONTAINER_INSTALLED_DIR / app_id / "docker-compose.yml")
                    self._run(
                        instance,
                        [
                            "docker", "compose", "-p", app_id,
                            "-f", compose_file, "--env-file", env_file,
                            "up", "-d", "--remove-orphans",
                        ],
                        acceptable={0, 1},
                    )
            except Exception as exc:
                logger.warning("Failed to repatch data files for %s: %s", app_id, exc)

    def install_app(self, app_id: str) -> None:
        self.ensure_bootstrapped()
        instance = self.ensure_started()
        if app_id == "openclaw":
            self._push_openclaw_overlay(instance)
            self._ensure_openclaw_workspace_device(instance)
        if app_id in ("openclaw", "hermes-agent", "anything-llm", "picoclaw"):
            # Install the LXD proxy device that bridges the host's loopback
            # model service into the LXC before docker compose comes up, so
            # the gateway can reach it on its first request.
            self._configure_provider_proxy(instance)
        bundle = docker.build_app_bundle(
            app_id,
            installed_dir=CONTAINER_INSTALLED_DIR,
            overlay_dir=CONTAINER_OVERLAY_DIR,
        )
        self._prepare_volume_paths(instance, bundle)
        self._write_file(instance, f"{bundle.app_dir}/docker-compose.yml", bundle.compose_text)
        self._write_file(instance, f"{bundle.app_dir}/.env", bundle.env_text, mode=0o600)
        if bundle.version:
            self._write_file(instance, f"{bundle.app_dir}/.nimbus-version", bundle.version + "\n")
        if app_id == "hermes-agent":
            self._configure_hermes_provider(instance, bundle.data_dir)
        if app_id == "picoclaw":
            self._configure_picoclaw_provider(instance, bundle.data_dir)
        self._wait_for_container_dns(instance)
        compose_cmd = [
            "docker", "compose",
            "-p", app_id,
            "-f", f"{bundle.app_dir}/docker-compose.yml",
            "--env-file", f"{bundle.app_dir}/.env",
        ]
        # Pull images separately before starting so that progress output keeps
        # the LXD exec WebSocket alive during long downloads.  Running
        # "up -d" alone is silent during the pull phase, which causes the exec
        # session to be killed after a few minutes on large images.
        self._run(instance, [*compose_cmd, "pull"])
        self._run(instance, [*compose_cmd, "up", "-d", "--remove-orphans"])
        self._configure_app_proxy(instance, app_id, bundle.published_port)
        if app_id == "openclaw":
            self._configure_openclaw_ws_proxy(instance)
        self._invalidate_snapshot()

    def update_app(self, app_id: str) -> None:
        self.ensure_bootstrapped()
        env_text = self.get_env_text(app_id)
        if not env_text:
            raise RuntimeError(f"App '{app_id}' has no saved environment")
        instance = self.ensure_started()
        if app_id == "openclaw":
            self._push_openclaw_overlay(instance)
            self._ensure_openclaw_workspace_device(instance)
        if app_id in ("openclaw", "hermes-agent"):
            self._configure_provider_proxy(instance)
        bundle = docker.build_app_bundle(
            app_id,
            installed_dir=CONTAINER_INSTALLED_DIR,
            env_text=env_text,
            overlay_dir=CONTAINER_OVERLAY_DIR,
        )
        self._prepare_volume_paths(instance, bundle)
        self._write_file(instance, f"{bundle.app_dir}/docker-compose.yml", bundle.compose_text)
        if bundle.version:
            self._write_file(instance, f"{bundle.app_dir}/.nimbus-version", bundle.version + "\n")
        self._wait_for_container_dns(instance)
        pull_code, _, pull_stderr = self._run(
            instance,
            [
                "docker",
                "compose",
                "-p",
                app_id,
                "-f",
                f"{bundle.app_dir}/docker-compose.yml",
                "--env-file",
                f"{bundle.app_dir}/.env",
                "pull",
            ],
            acceptable={0, 1},
        )
        if pull_code != 0:
            logger.warning("docker compose pull warning for %s: %s", app_id, pull_stderr)
        self._run(
            instance,
            [
                "docker",
                "compose",
                "-p",
                app_id,
                "-f",
                f"{bundle.app_dir}/docker-compose.yml",
                "--env-file",
                f"{bundle.app_dir}/.env",
                "up",
                "-d",
                "--remove-orphans",
            ],
        )
        self._configure_app_proxy(instance, app_id, bundle.published_port)
        if app_id == "openclaw":
            self._configure_openclaw_ws_proxy(instance)
        self._invalidate_snapshot()

    def uninstall_app(self, app_id: str) -> None:
        self.ensure_bootstrapped()
        instance = self.ensure_started()
        compose_file = f"{CONTAINER_INSTALLED_DIR / app_id / 'docker-compose.yml'}"
        env_file = f"{CONTAINER_INSTALLED_DIR / app_id / '.env'}"
        if self._file_exists(instance, compose_file):
            self._run(
                instance,
                [
                    "docker",
                    "compose",
                    "-p",
                    app_id,
                    "-f",
                    compose_file,
                    "--env-file",
                    env_file,
                    "down",
                    "-v",
                ],
                acceptable={0, 1},
            )
        self._configure_app_proxy(instance, app_id, None)
        # Remove any app-specific LXD devices before the directory removal so
        # bind mounts are properly unmounted first.  For openclaw this includes
        # the gateway WS proxy and the workspace bind-mount; if the bind mount
        # is still active when shutil.rmtree runs it silently fails to delete
        # the mount point, leaving the installed directory intact and making
        # the app appear still installed.
        devices = self._instance_devices(instance)
        extra_devices = [
            f"{self._proxy_device_name(app_id)}-ws",
            f"{app_id}-workspace",
        ]
        if any(d in devices for d in extra_devices):
            for d in extra_devices:
                devices.pop(d, None)
            self._save_instance_devices(instance, devices)
        self._run(
            instance,
            [
                "python3",
                "-c",
                "import pathlib, shutil, sys; p = pathlib.Path(sys.argv[1]); shutil.rmtree(p, ignore_errors=True)",
                str(CONTAINER_INSTALLED_DIR / app_id),
            ],
        )
        self._invalidate_snapshot()


_manager = LxdManager()


def get_lxd_manager() -> LxdManager:
    return _manager
