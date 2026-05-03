from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _parse_pressed_apps(env_val: str | None) -> list[str]:
    if not env_val:
        return []
    return [app_id.strip() for app_id in env_val.split(",") if app_id.strip()]


@dataclass(frozen=True)
class Settings:
    control_mode: str
    store_dir: Path
    installed_dir: Path
    caddy_ca_cert: Path
    primary_interface: str
    remote_base_url: str | None
    remote_token: str | None
    api_token: str | None
    serve_frontend: bool
    refresh_store_on_startup: bool
    lxd_auto_bootstrap: bool
    lxd_container_name: str
    lxd_profile_name: str
    lxd_image_server: str
    lxd_image_protocol: str
    lxd_image_alias: str
    lxd_agent_port: int
    lxd_agent_bind_host: str
    lxd_agent_token: str | None
    lxd_publish_host: str
    # Pressed apps: auto-installed on first run (comma-separated Umbrel app IDs)
    pressed_apps: list[str] = field(default_factory=list)
    # When True, the App Store UI is hidden (defaults to True when pressed_apps set)
    appstore_visible: bool = True
    # Root directory exposed by the file browser
    files_root: Path = field(default_factory=lambda: Path.home())


def _build_settings() -> Settings:
    control_mode = os.getenv("NIMBUS_CONTROL_MODE", "local").strip().lower()
    if control_mode not in {"local", "remote", "lxd"}:
        raise ValueError("NIMBUS_CONTROL_MODE must be 'local', 'remote', or 'lxd'")

    remote_base_url = os.getenv("NIMBUS_REMOTE_BASE_URL")
    if remote_base_url:
        remote_base_url = remote_base_url.rstrip("/")

    pressed_apps = _parse_pressed_apps(os.getenv("NIMBUS_PRESSED_APPS"))

    # App Store is visible unless explicitly disabled, or pressed_apps is set
    # and NIMBUS_APPSTORE_VISIBLE is not overridden.
    _appstore_default = len(pressed_apps) == 0
    appstore_visible = _env_bool("NIMBUS_APPSTORE_VISIBLE", _appstore_default)

    files_root_env = os.getenv("NIMBUS_FILES_ROOT")
    files_root = Path(files_root_env) if files_root_env else Path.home()

    return Settings(
        control_mode=control_mode,
        store_dir=Path(os.getenv("NIMBUS_STORE_DIR", "/var/lib/nimbus/store")),
        installed_dir=Path(os.getenv("NIMBUS_INSTALLED_DIR", "/var/lib/nimbus/installed")),
        caddy_ca_cert=Path(
            os.getenv(
                "NIMBUS_CADDY_CA_CERT",
                "/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt",
            )
        ),
        primary_interface=os.getenv("NIMBUS_PRIMARY_INTERFACE", "eth0"),
        remote_base_url=remote_base_url,
        remote_token=os.getenv("NIMBUS_REMOTE_TOKEN"),
        api_token=os.getenv("NIMBUS_API_TOKEN"),
        serve_frontend=_env_bool("NIMBUS_SERVE_FRONTEND", True),
        refresh_store_on_startup=_env_bool(
            "NIMBUS_REFRESH_STORE_ON_STARTUP",
            control_mode in {"local", "lxd"},
        ),
        lxd_auto_bootstrap=_env_bool("NIMBUS_LXD_AUTO_BOOTSTRAP", control_mode == "lxd"),
        lxd_container_name=os.getenv("NIMBUS_LXD_CONTAINER_NAME", "nimbus"),
        lxd_profile_name=os.getenv("NIMBUS_LXD_PROFILE_NAME", "nimbus-hosting"),
        lxd_image_server=os.getenv("NIMBUS_LXD_IMAGE_SERVER", "https://cloud-images.ubuntu.com/releases"),
        lxd_image_protocol=os.getenv("NIMBUS_LXD_IMAGE_PROTOCOL", "simplestreams"),
        lxd_image_alias=os.getenv("NIMBUS_LXD_IMAGE_ALIAS", "24.04"),
        lxd_agent_port=int(os.getenv("NIMBUS_LXD_AGENT_PORT", "8000")),
        lxd_agent_bind_host=os.getenv("NIMBUS_LXD_AGENT_BIND_HOST", "127.0.0.1"),
        lxd_agent_token=os.getenv("NIMBUS_LXD_AGENT_TOKEN") or os.getenv("NIMBUS_API_TOKEN"),
        lxd_publish_host=os.getenv("NIMBUS_LXD_PUBLISH_HOST", "0.0.0.0"),
        pressed_apps=pressed_apps,
        appstore_visible=appstore_visible,
        files_root=files_root,
    )


settings = _build_settings()
