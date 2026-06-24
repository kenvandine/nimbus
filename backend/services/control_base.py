"""Shared base class for control plane implementations.

Extracts common logic shared between LocalControlPlane and LxdControlPlane:
  - Installing/updating tracking
  - System commands (restart, power-off, update)
  - Update check loop
"""

from __future__ import annotations

import asyncio
import logging
import os

from fastapi import HTTPException

from config import settings
from services.device import get_device_manager
from models import SystemStats

logger = logging.getLogger(__name__)


class _call_device_manager:
    """Helper context that wraps device-manager calls with consistent error handling."""

    @staticmethod
    def run(func, *args):
        import asyncio
        try:
            return asyncio.get_event_loop().run_until_complete(
                asyncio.to_thread(func, *args)
            )
        except HTTPException:
            raise
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc


class ControlPlaneBase:
    """Base class providing shared control-plane functionality.

    Subclasses must implement:
      - _do_install(app_id)
      - _do_update(app_id)
      - request_install(app_id) — may call _do_install
      - request_update(app_id) — may call _do_update
      - list_apps()
      - get_app(app_id)
      - get_stats()
      - get_ca_cert()
      - initialize()
    """

    def __init__(self) -> None:
        self._installing: set[str] = set()
        self._updating: set[str] = set()

    async def active_installs(self) -> list[str]:
        return list(self._installing)

    async def restart_system(self) -> dict:
        await _device_call(get_device_manager().restart_system)
        return {"status": "restarting"}

    async def power_off_system(self) -> dict:
        await _device_call(get_device_manager().power_off_system)
        return {"status": "powering_off"}

    async def _do_system_update(self, targets: list[str]) -> None:
        try:
            await asyncio.to_thread(get_device_manager().refresh_system, targets)
        except Exception as exc:
            logger.error("System update failed: %s", exc)

    async def update_system(self) -> dict:
        data = await _device_call(get_device_manager().request_system_refresh)
        if data["status"] == "running":
            asyncio.create_task(self._do_system_update(list(data.get("targets", []))))
        return dict(data)


async def _device_call(func, *args):
    """Run a device-manager function, converting errors appropriately."""
    import asyncio
    try:
        return await asyncio.to_thread(func, *args)
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
