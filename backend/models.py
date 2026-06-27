from __future__ import annotations
from typing import Optional
from pydantic import BaseModel


class AppMeta(BaseModel):
    id: str
    name: str
    tagline: str = ""
    description: str = ""
    icon: str = ""
    categories: list[str] = []
    port_hint: Optional[int] = None
    gallery: list[str] = []
    website: str = ""
    developer: str = ""
    version: str = ""
    default_username: str = ""
    default_password: str = ""
    deterministic_password: bool = False
    # snap-specific fields
    app_type: str = "docker"          # "docker" | "snap"
    confinement: Optional[str] = None  # "strict" | "classic" | "devmode"
    ports: list[int] = []              # catalog-declared ports for snap apps
    post_install_script: Optional[str] = None
    supported: bool = False



class AppStatus(BaseModel):
    installed: bool = False
    running: bool = False
    port: Optional[int] = None
    open_url: Optional[str] = None
    update_available: bool = False


class AppDetail(AppMeta, AppStatus):
    # True for built-in system apps (e.g. Lemonade) that cannot be uninstalled
    is_system: bool = False
    # True if this app has a managed systemd service (start/stop/restart supported)
    has_service: bool = False


class SnapshotInfo(BaseModel):
    name: str
    created_at: str
    description: str = ""
    stateful: bool = False


class ResourceLimits(BaseModel):
    cpu_cores: Optional[int] = None
    memory_mb: Optional[int] = None


class SystemStats(BaseModel):
    cpu_pct: float
    mem_pct: float
    disk_pct: float
    app_count: int
    control_mode: str = "local"
    container_name: Optional[str] = None
    container_status: Optional[str] = None
    container_ip: Optional[str] = None
    container_bootstrapped: bool = False
    bootstrap_state: Optional[str] = None
    bootstrap_error: Optional[str] = None
    device_management_available: bool = False
    system_update_supported: bool = False
    system_update_available: bool = False
    system_update_targets: list[str] = []
    system_update_status: Optional[str] = None
    system_update_message: Optional[str] = None
    system_restart_required: bool = False
    oobe_complete: bool = True
    online: bool = True
    appstore_visible: bool = True
    version: str = ""
    host_ip: Optional[str] = None
    # Terminal access to the managed LXC container
    terminal_available: bool = False
    # TLS certificate info
    tls_enabled: bool = False
    tls_fingerprint: Optional[str] = None
    # App updates available count (across all installed apps)
    update_available_count: int = 0
    # App store / catalog backend
    app_store_type: str = "nimbus"
    # Container resource limits
    container_cpu_limit: Optional[int] = None
    container_mem_limit_mb: Optional[int] = None
