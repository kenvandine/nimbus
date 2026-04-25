from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path

from config import settings

try:
    import requests_unixsocket
except Exception as exc:  # pragma: no cover - optional runtime dependency
    requests_unixsocket = None
    REQUESTS_UNIXSOCKET_IMPORT_ERROR = exc
else:
    REQUESTS_UNIXSOCKET_IMPORT_ERROR = None

try:
    import gi

    gi.require_version("Snapd", "2")
    from gi.repository import Snapd
except Exception as exc:  # pragma: no cover - optional runtime dependency
    Snapd = None
    SNAPD_GI_IMPORT_ERROR = exc
else:
    SNAPD_GI_IMPORT_ERROR = None

logger = logging.getLogger(__name__)

SNAPD_SOCKET_PATH = Path("/run/snapd.socket")
SNAPD_SOCKET_URL = "http+unix://%2Frun%2Fsnapd.socket"
CORE_BASE_SNAP = "core24"
SNAPD_SNAP = "snapd"
LXD_SNAP = "lxd"

# Disabled until the snap is published with snapd-control access
SNAPD_ENABLED = False


def _logind_action(method: str) -> None:
    # Fall back to calling logind directly via D-Bus using the shutdown plug.
    # This bypasses snapd's scheduler and works even when a systemd block
    # inhibitor (e.g. GNOME session manager) prevents snapd from scheduling.
    try:
        import dbus

        bus = dbus.SystemBus()
        obj = bus.get_object("org.freedesktop.login1", "/org/freedesktop/login1")
        getattr(obj, method)(False, dbus_interface="org.freedesktop.login1.Manager")
    except Exception as exc:
        logger.warning("logind %s fallback failed: %s", method, exc)


class SnapdRequestError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class DeviceManagementStatus:
    actions_available: bool
    system_update_supported: bool
    system_update_available: bool
    system_update_targets: list[str]
    system_update_status: str | None
    system_update_message: str | None
    system_restart_required: bool


@dataclass
class SystemUpdateState:
    status: str = "idle"
    message: str | None = None
    restart_required: bool = False
    current_boot_id: str | None = None
    requested_targets: list[str] = field(default_factory=list)


def _format_snap_names(names: list[str]) -> str:
    labels = {
        CORE_BASE_SNAP: "core24",
        SNAPD_SNAP: "snapd",
        LXD_SNAP: "LXD",
    }

    def display(name: str) -> str:
        if name.startswith("nimbus"):
            return "Nimbus"
        return labels.get(name, name)

    rendered = [display(name) for name in names]
    if not rendered:
        return ""
    if len(rendered) == 1:
        return rendered[0]
    if len(rendered) == 2:
        return f"{rendered[0]} and {rendered[1]}"
    return f"{', '.join(rendered[:-1])}, and {rendered[-1]}"


class DeviceManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state_file = settings.installed_dir.parent / "system-update-state.json"
        self._update_state = self._load_update_state()

    def actions_available(self) -> bool:
        return SNAPD_ENABLED and requests_unixsocket is not None and SNAPD_SOCKET_PATH.exists()

    def system_update_supported(self) -> bool:
        return SNAPD_ENABLED and Snapd is not None and SNAPD_SOCKET_PATH.exists()

    def _current_boot_id(self) -> str:
        try:
            return (
                Path("/proc/sys/kernel/random/boot_id")
                .read_text(encoding="utf-8")
                .strip()
            )
        except OSError:
            return ""

    def _managed_snap_names(self) -> list[str]:
        names = [CORE_BASE_SNAP, SNAPD_SNAP, LXD_SNAP]
        nimbus_name = os.getenv("SNAP_INSTANCE_NAME") or os.getenv("SNAP_NAME")
        if nimbus_name:
            names.append(nimbus_name)
        else:
            names.append("nimbus")

        unique: list[str] = []
        for name in names:
            if name not in unique:
                unique.append(name)
        return unique

    def _load_update_state(self) -> SystemUpdateState:
        if not self._state_file.exists():
            return SystemUpdateState(current_boot_id=self._current_boot_id())
        try:
            payload = json.loads(self._state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            logger.warning("Could not read persisted system update state: %s", exc)
            return SystemUpdateState(current_boot_id=self._current_boot_id())

        return SystemUpdateState(
            status=str(payload.get("status") or "idle"),
            message=payload.get("message"),
            restart_required=bool(payload.get("restart_required")),
            current_boot_id=str(
                payload.get("current_boot_id") or self._current_boot_id()
            ),
            requested_targets=[
                str(item) for item in payload.get("requested_targets", [])
            ],
        )

    def _persist_update_state(self) -> None:
        try:
            self._state_file.parent.mkdir(parents=True, exist_ok=True)
            self._state_file.write_text(
                json.dumps(asdict(self._update_state)), encoding="utf-8"
            )
        except OSError as exc:
            logger.warning("Could not persist system update state: %s", exc)

    def status(self) -> DeviceManagementStatus:
        with self._lock:
            update_state = SystemUpdateState(
                status=self._update_state.status,
                message=self._update_state.message,
                restart_required=self._update_state.restart_required,
                current_boot_id=self._update_state.current_boot_id,
                requested_targets=list(self._update_state.requested_targets),
            )
        available_targets = (
            self._refreshable_target_names() if self.system_update_supported() else []
        )
        display_targets = available_targets or []
        if (
            update_state.restart_required
            and update_state.current_boot_id
            and update_state.current_boot_id != self._current_boot_id()
        ):
            self._set_update_state(
                "idle", None, restart_required=False, requested_targets=[]
            )
            update_state = SystemUpdateState(current_boot_id=self._current_boot_id())
        elif update_state.status == "running" and update_state.requested_targets:
            if available_targets is not None:
                pending_requested = [
                    name
                    for name in update_state.requested_targets
                    if name in available_targets
                ]
            else:
                pending_requested = update_state.requested_targets
            if available_targets is not None and not pending_requested:
                if update_state.restart_required:
                    self._set_update_state(
                        "completed",
                        "System updates finished. Restart the device to apply the updated core24 base snap.",
                        restart_required=True,
                        requested_targets=[],
                    )
                else:
                    self._set_update_state(
                        "completed",
                        "System updates finished.",
                        restart_required=False,
                        requested_targets=[],
                    )
                with self._lock:
                    update_state = SystemUpdateState(
                        status=self._update_state.status,
                        message=self._update_state.message,
                        restart_required=self._update_state.restart_required,
                        current_boot_id=self._update_state.current_boot_id,
                        requested_targets=list(self._update_state.requested_targets),
                    )

        message = update_state.message
        if not message:
            if update_state.status == "idle":
                if display_targets:
                    message = (
                        f"Updates available for {_format_snap_names(display_targets)}."
                    )
                elif self.system_update_supported():
                    message = "System is up to date."
                else:
                    message = "System updates are unavailable until Nimbus can access snapd on the host."
            elif (
                update_state.status == "completed" and not update_state.restart_required
            ):
                message = "System is up to date."

        return DeviceManagementStatus(
            actions_available=self.actions_available(),
            system_update_supported=self.system_update_supported(),
            system_update_available=bool(display_targets),
            system_update_targets=display_targets,
            system_update_status=update_state.status,
            system_update_message=message,
            system_restart_required=update_state.restart_required,
        )

    def _set_update_state(
        self,
        status: str,
        message: str | None,
        restart_required: bool = False,
        requested_targets: list[str] | None = None,
    ) -> None:
        with self._lock:
            self._update_state = SystemUpdateState(
                status=status,
                message=message,
                restart_required=restart_required,
                current_boot_id=self._current_boot_id(),
                requested_targets=list(requested_targets or []),
            )
            self._persist_update_state()

    def _require_actions_available(self) -> None:
        if not SNAPD_ENABLED:
            raise RuntimeError("snapd API calls are temporarily disabled")
        if requests_unixsocket is None:
            raise RuntimeError(
                f"requests-unixsocket is unavailable: {REQUESTS_UNIXSOCKET_IMPORT_ERROR}"
            )
        if not SNAPD_SOCKET_PATH.exists():
            raise RuntimeError("snapd socket is unavailable on this system")

    def _require_system_update_available(self) -> None:
        if not SNAPD_SOCKET_PATH.exists():
            raise RuntimeError("snapd socket is unavailable on this system")
        if Snapd is None:
            raise RuntimeError(
                f"Snapd GI bindings are unavailable: {SNAPD_GI_IMPORT_ERROR}"
            )

    def _refreshable_target_names(
        self, *, raise_on_error: bool = False
    ) -> list[str] | None:
        if not self.system_update_supported():
            return []
        try:
            client = Snapd.Client()
            refreshable = client.find_refreshable_sync(None)
        except Exception as exc:
            if raise_on_error:
                raise RuntimeError(f"Could not query refreshable snaps: {exc}") from exc
            logger.warning("Could not query refreshable snaps: %s", exc)
            return None

        refreshable_names = {snap.get_name() for snap in refreshable}
        return [
            name for name in self._managed_snap_names() if name in refreshable_names
        ]

    def _socket_request(
        self, method: str, path: str, payload: dict | None = None
    ) -> dict:
        self._require_actions_available()
        session = requests_unixsocket.Session()
        response = session.request(
            method,
            f"{SNAPD_SOCKET_URL}{path}",
            json=payload,
            timeout=30,
        )

        try:
            data = response.json()
        except ValueError as exc:
            raise SnapdRequestError(
                response.text.strip() or "snapd returned an invalid response",
                response.status_code,
            ) from exc

        if response.status_code >= 400 or data.get("type") == "error":
            result = data.get("result")
            if isinstance(result, dict):
                message = str(result.get("message") or response.text)
            else:
                message = response.text
            raise SnapdRequestError(
                message.strip() or "snapd request failed", response.status_code
            )

        return data

    def restart_system(self) -> None:
        try:
            self._socket_request("POST", "/v2/systems", {"action": "reboot"})
        except SnapdRequestError:
            pass
        _logind_action("Reboot")

    def power_off_system(self) -> None:
        try:
            self._socket_request("POST", "/v2/systems", {"action": "poweroff"})
        except SnapdRequestError as exc:
            if (
                exc.status_code not in {400, 404}
                and "unsupported action" not in str(exc).lower()
            ):
                raise
            try:
                self._socket_request("POST", "/v2/systems", {"action": "shutdown"})
            except SnapdRequestError:
                pass
        _logind_action("PowerOff")

    def request_system_refresh(self) -> dict:
        self._require_system_update_available()
        targets = self._refreshable_target_names(raise_on_error=True) or []
        with self._lock:
            if self._update_state.status == "running":
                return {"status": "already_running"}
            if not targets:
                self._update_state = SystemUpdateState(
                    status="completed",
                    message="System is already up to date.",
                    restart_required=False,
                    current_boot_id=self._current_boot_id(),
                    requested_targets=[],
                )
                self._persist_update_state()
                return {"status": "up_to_date", "targets": []}
            self._update_state = SystemUpdateState(
                status="running",
                message=f"Updating {_format_snap_names(targets)}…",
                restart_required=False,
                current_boot_id=self._current_boot_id(),
                requested_targets=list(targets),
            )
            self._persist_update_state()
        return {"status": "running", "targets": targets}

    def refresh_system(self, targets: list[str]) -> None:
        self._require_system_update_available()
        client = Snapd.Client()
        target_names = [name for name in self._managed_snap_names() if name in targets]
        if not target_names:
            self._set_update_state(
                "completed", "System is already up to date.", requested_targets=[]
            )
            return
        try:
            restart_required = False
            for snap_name in target_names:
                refreshed = client.refresh_sync(snap_name, None, None, None, None)
                if not refreshed:
                    raise RuntimeError(
                        f"snapd did not accept the refresh request for {snap_name}"
                    )
                if snap_name == CORE_BASE_SNAP:
                    restart_required = True
                    self._set_update_state(
                        "running",
                        "core24 has been updated. Finishing remaining system updates…",
                        restart_required=True,
                        requested_targets=target_names,
                    )

            if restart_required:
                self._set_update_state(
                    "completed",
                    "System updates finished. Restart the device to apply the updated core24 base snap.",
                    restart_required=True,
                    requested_targets=[],
                )
            else:
                self._set_update_state(
                    "completed",
                    "System updates finished.",
                    restart_required=False,
                    requested_targets=[],
                )
        except Exception as exc:
            logger.error("System update failed: %s", exc)
            with self._lock:
                restart_required = self._update_state.restart_required
            self._set_update_state(
                "failed",
                f"System update failed: {exc}",
                restart_required=restart_required,
                requested_targets=target_names,
            )
            raise


device_manager = DeviceManager()


def get_device_manager() -> DeviceManager:
    return device_manager


def _oobe_marker() -> Path:
    return settings.installed_dir.parent / "oobe-complete"


def is_oobe_complete() -> bool:
    if settings.control_mode != "lxd":
        return True
    return _oobe_marker().exists()


def mark_oobe_complete() -> None:
    marker = _oobe_marker()
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.touch()
