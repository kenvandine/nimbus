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


class AppStatus(BaseModel):
    installed: bool = False
    running: bool = False
    port: Optional[int] = None
    open_url: Optional[str] = None
    update_available: bool = False


class AppDetail(AppMeta, AppStatus):
    # True for built-in system apps (e.g. Lemonade) that cannot be uninstalled
    is_system: bool = False


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
    # Whether the App Store UI should be shown
    appstore_visible: bool = True
    version: str = ""
