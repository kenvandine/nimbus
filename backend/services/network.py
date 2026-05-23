from __future__ import annotations
import asyncio
import logging

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
    except Exception as exc:
        logger.debug("NetworkManager dbus check failed: %s", exc)
    # Fallback: check /proc/net/route for a default route (Destination == 00000000).
    # Readable via the network-observe snap interface; avoids exec of /usr/bin/ip
    # which is denied under strict AppArmor confinement.
    try:
        with open("/proc/net/route") as f:
            next(f)  # skip header
            for line in f:
                parts = line.split()
                if len(parts) >= 2 and parts[1] == "00000000":
                    return True
    except Exception as exc:
        logger.debug("/proc/net/route check failed: %s", exc)
    return False


async def get_host_ip() -> str:
    global _cached_ip
    if _cached_ip:
        return _cached_ip

    # Ask NetworkManager which interface carries the default route, then read
    # its IP. This works on both WiFi and Ethernet without manual configuration.
    # Fall back to NIMBUS_PRIMARY_INTERFACE if NM is unavailable.
    iface = get_primary_interface() or settings.primary_interface

    # Use psutil (a snap dependency) to read interface addresses — avoids
    # exec of /usr/bin/ip which is denied under strict AppArmor confinement.
    try:
        import socket
        import psutil
        for addr in psutil.net_if_addrs().get(iface, []):
            if addr.family == socket.AF_INET:
                _cached_ip = addr.address
                return _cached_ip
    except Exception as exc:
        logger.warning("psutil addr lookup for %s failed: %s", iface, exc)

    # Fallback: first non-loopback, non-docker IPv4 address across all interfaces.
    try:
        import socket
        import psutil
        for addrs in psutil.net_if_addrs().values():
            for addr in addrs:
                if addr.family == socket.AF_INET and not addr.address.startswith(("127.", "172.")):
                    _cached_ip = addr.address
                    return _cached_ip
    except Exception as exc:
        logger.warning("psutil fallback addr scan failed: %s", exc)

    return "127.0.0.1"


def build_open_url(host_ip: str, port: int) -> str:
    return f"http://{host_ip}:{port}"
