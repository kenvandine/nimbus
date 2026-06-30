from __future__ import annotations

import logging
import socket

logger = logging.getLogger(__name__)

_TAILSCALE_IFACE = "tailscale0"


def get_status() -> dict:
    """Return tailscale connection status using psutil (no extra snap permissions)."""
    try:
        import psutil
        ifaces = psutil.net_if_addrs()
        if _TAILSCALE_IFACE in ifaces:
            tailscale_ip = None
            for addr in ifaces[_TAILSCALE_IFACE]:
                if addr.family == socket.AF_INET:
                    tailscale_ip = addr.address
                    break
            return {
                "available": True,
                "connected": True,
                "tailscale_ip": tailscale_ip,
                "webclient_url": f"http://{tailscale_ip}:5252" if tailscale_ip else None,
            }
    except Exception as exc:
        logger.debug("psutil tailscale check failed: %s", exc)

    return {
        "available": False,
        "connected": False,
        "tailscale_ip": None,
        "webclient_url": None,
    }
