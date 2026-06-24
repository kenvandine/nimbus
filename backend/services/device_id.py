"""Persistent unique device identifier.

The device ID is a UUID generated on first boot and stored in
$SNAP_COMMON/device-id.  It is stable across reboots and snap refreshes,
and is used as the per-device subdomain name with the provisioning backend.
"""
from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path

logger = logging.getLogger(__name__)


def _device_id_path() -> Path:
    snap_common = os.environ.get("SNAP_COMMON", "")
    base = Path(snap_common) if snap_common else Path.home() / ".nimbus"
    return base / "device-id"


def get_device_id() -> str:
    """Return the persistent device UUID, creating one on first call."""
    path = _device_id_path()
    if path.exists():
        try:
            device_id = path.read_text().strip()
            if device_id:
                return device_id
        except Exception:
            pass

    device_id = str(uuid.uuid4())
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(device_id)
        logger.info("Device ID created: %s", device_id)
    except Exception as exc:
        logger.warning("Could not persist device ID: %s", exc)

    return device_id
