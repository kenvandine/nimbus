from __future__ import annotations
import asyncio
import logging
import subprocess

from config import settings

logger = logging.getLogger(__name__)

_cached_ip: str | None = None

# NetworkManager state values
_NM_STATE_CONNECTED_SITE = 60
_NM_STATE_CONNECTED_GLOBAL = 70


def get_primary_interface() -> str | None:
    """Return the interface name that carries the default IPv4 route, via NetworkManager."""
    try:
        import dbus
        bus = dbus.SystemBus()
        nm = bus.get_object("org.freedesktop.NetworkManager", "/org/freedesktop/NetworkManager")
        active_connections = dbus.Interface(nm, "org.freedesktop.DBus.Properties").Get(
            "org.freedesktop.NetworkManager", "ActiveConnections"
        )
        for conn_path in active_connections:
            conn = bus.get_object("org.freedesktop.NetworkManager", str(conn_path))
            props = dbus.Interface(conn, "org.freedesktop.DBus.Properties")
            if props.Get("org.freedesktop.NetworkManager.Connection.Active", "Default"):
                devices = props.Get("org.freedesktop.NetworkManager.Connection.Active", "Devices")
                if devices:
                    dev = bus.get_object("org.freedesktop.NetworkManager", str(devices[0]))
                    iface = dbus.Interface(dev, "org.freedesktop.DBus.Properties").Get(
                        "org.freedesktop.NetworkManager.Device", "Interface"
                    )
                    return str(iface)
    except Exception as exc:
        logger.debug("Could not determine primary interface via NetworkManager: %s", exc)
    return None


def is_online() -> bool:
    """Return True if the host has site-level or better network connectivity."""
    try:
        import dbus
        bus = dbus.SystemBus()
        nm = bus.get_object("org.freedesktop.NetworkManager", "/org/freedesktop/NetworkManager")
        state = int(dbus.Interface(nm, "org.freedesktop.DBus.Properties").Get(
            "org.freedesktop.NetworkManager", "State"
        ))
        return state >= _NM_STATE_CONNECTED_SITE
    except Exception:
        pass
    # Fallback: presence of a default route
    try:
        result = subprocess.run(
            ["ip", "route", "show", "default"],
            capture_output=True, text=True, timeout=5,
        )
        return bool(result.stdout.strip())
    except Exception:
        pass
    return False


async def get_host_ip() -> str:
    global _cached_ip
    if _cached_ip:
        return _cached_ip

    # Ask NetworkManager which interface carries the default route, then read
    # its IP. This works on both WiFi and Ethernet without manual configuration.
    # Fall back to NIMBUS_PRIMARY_INTERFACE if NM is unavailable.
    iface = get_primary_interface() or settings.primary_interface
    try:
        proc = await asyncio.create_subprocess_exec(
            "ip", "-4", "addr", "show", iface,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        import re
        m = re.search(r'inet (\d+\.\d+\.\d+\.\d+)', stdout.decode())
        if m:
            _cached_ip = m.group(1)
            return _cached_ip
    except Exception as exc:
        logger.warning("ip addr show %s failed: %s", iface, exc)

    # Fallback: first non-loopback, non-docker IP from hostname -I
    try:
        proc = await asyncio.create_subprocess_exec(
            "hostname", "-I",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        for ip in stdout.decode().split():
            if not ip.startswith("127.") and not ip.startswith("172."):
                _cached_ip = ip
                return _cached_ip
    except Exception as exc:
        logger.warning("hostname -I failed: %s", exc)

    return "127.0.0.1"


def build_open_url(host_ip: str, port: int) -> str:
    return f"http://{host_ip}:{port}"
