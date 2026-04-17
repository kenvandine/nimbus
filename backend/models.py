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


class AppStatus(BaseModel):
    installed: bool = False
    running: bool = False
    port: Optional[int] = None
    open_url: Optional[str] = None


class AppDetail(AppMeta, AppStatus):
    pass


class SystemStats(BaseModel):
    cpu_pct: float
    mem_pct: float
    disk_pct: float
    app_count: int
