"""Audio feedback for the appliance.

Plays bundled sounds (staged into the snap at $SNAP/share/sounds/nimbus, or
from /usr/share/sounds/Yaru/stereo on a dev machine) with paplay. Used for
the boot-ready chime; the host key-poweroff watcher uses the same convention
for its held-button warning bell.
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import time
from pathlib import Path

logger = logging.getLogger(__name__)

BOOT_CHIME_SOUND = "warty-startup"
BOOT_CHIME_WAIT_SECONDS = 300.0


def sound_dir() -> str:
    snap = os.environ.get("SNAP")
    if snap:
        return os.path.join(snap, "share", "sounds", "nimbus")
    return "/usr/share/sounds/Yaru/stereo"


def sound_path(name: str) -> str:
    return os.path.join(sound_dir(), name + ".oga")


def play(name: str, timeout: float = 60.0) -> bool:
    """Play a bundled sound by name (bell, warty-startup). Returns success."""
    import shutil

    path = sound_path(name)
    if not os.path.exists(path):
        logger.warning("sound %r not found at %s", name, path)
        return False
    snap = os.environ.get("SNAP")
    if snap:
        paplay = os.path.join(snap, "usr", "bin", "paplay")
        if not os.path.exists(paplay):
            logger.warning("paplay not found at %s", paplay)
            return False
    else:
        paplay = shutil.which("paplay")
        if not paplay:
            logger.warning("paplay not found in PATH")
            return False
    try:
        proc = subprocess.run([paplay, path], timeout=timeout,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if proc.returncode != 0:
            logger.warning("paplay %s failed (exit %d)", path, proc.returncode)
            return False
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.warning("paplay %s failed: %s", path, exc)
        return False
    logger.info("played sound %r", name)
    return True


def _boot_id() -> str:
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        return ""


def _chime_marker() -> Path | None:
    common = os.environ.get("SNAP_COMMON")
    if not common:
        return None
    return Path(common) / ".boot-chime-boot-id"


def _web_service_up() -> bool:
    """Return True if the web service answers on its local port."""
    import httpx

    from config import settings
    port = int(os.environ.get("NIMBUS_PORT", "443"))
    scheme = "https" if settings.tls_enabled else "http"
    url = f"{scheme}://127.0.0.1:{port}/api/system/stats"
    try:
        # Any HTTP response (even 401/404) proves the service is serving.
        httpx.get(url, verify=False, timeout=3.0)
        return True
    except Exception as exc:
        logger.debug("web service check failed: %s", exc)
        return False


def _on_network() -> bool:
    """Return True if the device is on the network: host AP mode is active,
    or it is connected to wifi/ethernet."""
    from services import network, wifi
    try:
        return network.is_online() or wifi.is_ap_active()
    except Exception as exc:
        logger.debug("boot-ready network check failed: %s", exc)
        return False


async def announce_boot_ready() -> None:
    """Play the startup chime once the device has finished booting, is
    available on the network (host AP mode or wifi/ethernet), and the web
    service is serving. Plays at most once per boot."""
    marker = _chime_marker()
    boot_id = _boot_id()
    if marker is not None and boot_id:
        try:
            if marker.read_text().strip() == boot_id:
                logger.info("boot-ready chime already played this boot")
                return
        except OSError:
            pass

    await asyncio.sleep(5.0)  # let NetworkManager and the AP logic settle
    deadline = time.monotonic() + BOOT_CHIME_WAIT_SECONDS
    while time.monotonic() < deadline:
        web_up = await asyncio.to_thread(_web_service_up)
        on_network = await asyncio.to_thread(_on_network)
        if web_up and on_network:
            if await asyncio.to_thread(play, BOOT_CHIME_SOUND):
                if marker is not None and boot_id:
                    try:
                        marker.write_text(boot_id)
                    except OSError:
                        pass
                logger.info("boot-ready chime played (web up, network ready)")
            return
        await asyncio.sleep(3.0)
    logger.info("boot-ready chime skipped (conditions not met within %.0fs)",
                BOOT_CHIME_WAIT_SECONDS)
