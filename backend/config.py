from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


_DEFAULT_APPSTORE_WHITELIST = [
    "openclaw", "hermes-agent", "jellyfin", "obsidian",
    "picoclaw", "anything-llm", "immich",
]


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _parse_preseed_apps(env_val: str | None) -> list[str]:
    if not env_val:
        return []
    return [app_id.strip() for app_id in env_val.split(",") if app_id.strip()]


# Supported values for NIMBUS_MODEL_PROVIDER. Drives which local-LLM backend
# OpenClaw is wired up against.
MODEL_PROVIDER_LEMONADE = "lemonade-server"
MODEL_PROVIDER_GEMMA4 = "inference-snap-gemma4"
MODEL_PROVIDERS = {MODEL_PROVIDER_LEMONADE, MODEL_PROVIDER_GEMMA4}

# Per-provider default OpenAI-compatible endpoint. Used when NIMBUS_OPENAI_URL
# is unset; the nimbus snap can't run `gemma4 status` (strict confinement), so
# the operator points the snap setting at the right URL instead of relying on
# in-process discovery.
DEFAULT_OPENAI_URL = {
    MODEL_PROVIDER_LEMONADE: "http://127.0.0.1:13305/api/v1",
    MODEL_PROVIDER_GEMMA4: "http://127.0.0.1:8336/v1",
}


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
    lxd_local_image_alias: str
    lxd_agent_port: int
    lxd_agent_bind_host: str
    lxd_agent_token: str | None
    lxd_publish_host: str
    # Preseed apps: auto-installed on first run; always includes openclaw
    preseed_apps: list[str] = field(default_factory=list)
    # Whether the App Store UI is shown (default True; set NIMBUS_APPSTORE_VISIBLE=false to hide)
    appstore_visible: bool = True
    # App IDs shown in the App Store. Overridden by NIMBUS_APPSTORE_WHITELIST (comma-separated).
    appstore_whitelist: list[str] = field(default_factory=list)
    # Root directory exposed by the file browser
    files_root: Path = field(default_factory=lambda: Path.home())
    # Directory containing nimbus-shipped overlay files for Umbrel apps
    # (e.g. openclaw-overlay/setup-wrapper.cjs).
    overlay_dir: Path = field(default_factory=lambda: Path("/usr/share/nimbus"))
    # Local-LLM backend OpenClaw is configured against. One of
    # MODEL_PROVIDER_LEMONADE, MODEL_PROVIDER_GEMMA4.
    model_provider: str = MODEL_PROVIDER_LEMONADE
    # Full OpenAI-compatible API URL (including /v1 or /api/v1 suffix) that
    # OpenClaw will be pointed at. Defaults derived from model_provider when
    # NIMBUS_OPENAI_URL is unset.
    openai_url: str = DEFAULT_OPENAI_URL[MODEL_PROVIDER_LEMONADE]


def _build_settings() -> Settings:
    control_mode = os.getenv("NIMBUS_CONTROL_MODE", "local").strip().lower()
    if control_mode not in {"local", "remote", "lxd"}:
        raise ValueError("NIMBUS_CONTROL_MODE must be 'local', 'remote', or 'lxd'")

    remote_base_url = os.getenv("NIMBUS_REMOTE_BASE_URL")
    if remote_base_url:
        remote_base_url = remote_base_url.rstrip("/")

    appstore_visible = _env_bool("NIMBUS_APPSTORE_VISIBLE", True)

    whitelist_env = os.getenv("NIMBUS_APPSTORE_WHITELIST", "").strip()
    if whitelist_env:
        appstore_whitelist = [a.strip() for a in whitelist_env.split(",") if a.strip()]
    else:
        appstore_whitelist = list(_DEFAULT_APPSTORE_WHITELIST)

    # When the App Store is visible, users install openclaw themselves; skip
    # auto-preseed so first-boot doesn't block on it. When the store is hidden,
    # preseed openclaw automatically since there's no other way to get it.
    _user_apps = _parse_preseed_apps(os.getenv("NIMBUS_PRESEED_APPS"))
    if appstore_visible:
        preseed_apps = [a for a in _user_apps if a != "openclaw"]
    else:
        preseed_apps = ["openclaw"] + [a for a in _user_apps if a != "openclaw"]

    files_root_env = os.getenv("NIMBUS_FILES_ROOT")
    files_root = Path(files_root_env) if files_root_env else Path.home()

    # In a snap, $SNAP/share is the natural home for shipped data assets;
    # outside the snap, default to the in-tree location for dev runs.
    overlay_env = os.getenv("NIMBUS_OVERLAY_DIR")
    if overlay_env:
        overlay_dir = Path(overlay_env)
    elif os.getenv("SNAP"):
        overlay_dir = Path(os.environ["SNAP"]) / "share"
    else:
        overlay_dir = Path(__file__).resolve().parent.parent

    model_provider = os.getenv("NIMBUS_MODEL_PROVIDER", MODEL_PROVIDER_LEMONADE).strip().lower()
    if model_provider not in MODEL_PROVIDERS:
        raise ValueError(
            f"NIMBUS_MODEL_PROVIDER must be one of: {', '.join(sorted(MODEL_PROVIDERS))}"
        )

    openai_url_env = (os.getenv("NIMBUS_OPENAI_URL") or "").strip()
    openai_url = (openai_url_env or DEFAULT_OPENAI_URL[model_provider]).rstrip("/")

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
        lxd_local_image_alias=os.getenv("NIMBUS_LXD_LOCAL_IMAGE_ALIAS", ""),
        lxd_agent_port=int(os.getenv("NIMBUS_LXD_AGENT_PORT", "8000")),
        lxd_agent_bind_host=os.getenv("NIMBUS_LXD_AGENT_BIND_HOST", "127.0.0.1"),
        lxd_agent_token=os.getenv("NIMBUS_LXD_AGENT_TOKEN") or os.getenv("NIMBUS_API_TOKEN"),
        lxd_publish_host=os.getenv("NIMBUS_LXD_PUBLISH_HOST", "0.0.0.0"),
        preseed_apps=preseed_apps,
        appstore_visible=appstore_visible,
        appstore_whitelist=appstore_whitelist,
        files_root=files_root,
        overlay_dir=overlay_dir,
        model_provider=model_provider,
        openai_url=openai_url,
    )


settings = _build_settings()
