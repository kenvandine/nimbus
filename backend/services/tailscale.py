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
            # Only mark as connected once the device has a 100.x.x.x address —
            # tailscale0 is created at daemon startup but the IP is only assigned
            # after the device authenticates and joins the tailnet.
            connected = tailscale_ip is not None
            return {
                "available": True,
                "connected": connected,
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
