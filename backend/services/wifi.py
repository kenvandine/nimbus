from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

NM_SERVICE = "org.freedesktop.NetworkManager"
NM_PATH = "/org/freedesktop/NetworkManager"
NM_IFACE = "org.freedesktop.NetworkManager"
NM_DEVICE_IFACE = "org.freedesktop.NetworkManager.Device"
NM_WIRELESS_IFACE = "org.freedesktop.NetworkManager.Device.Wireless"
NM_AP_IFACE = "org.freedesktop.NetworkManager.AccessPoint"
NM_IP4_CONFIG_IFACE = "org.freedesktop.NetworkManager.IP4Config"
NM_SETTINGS_PATH = "/org/freedesktop/NetworkManager/Settings"
NM_SETTINGS_IFACE = "org.freedesktop.NetworkManager.Settings"
NM_CONN_IFACE = "org.freedesktop.NetworkManager.Settings.Connection"
DBUS_PROPS_IFACE = "org.freedesktop.DBus.Properties"

NM_DEVICE_TYPE_WIFI = 2
NM_802_11_AP_FLAGS_PRIVACY = 0x1


@dataclass
class AccessPoint:
    ssid: str
    strength: int
    secured: bool
    in_use: bool
    known: bool


@dataclass
class WifiStatus:
    available: bool
    enabled: bool
    connected: bool
    ssid: Optional[str] = None
    ip_address: Optional[str] = None
    error: Optional[str] = None


def _bus():
    import dbus
    return dbus.SystemBus()


def _find_wifi_device(bus):
    import dbus
    nm = bus.get_object(NM_SERVICE, NM_PATH)
    nm_iface = dbus.Interface(nm, NM_IFACE)
    for dev_path in nm_iface.GetAllDevices():
        dev = bus.get_object(NM_SERVICE, dev_path)
        try:
            props = dbus.Interface(dev, DBUS_PROPS_IFACE).GetAll(NM_DEVICE_IFACE)
            if int(props["DeviceType"]) == NM_DEVICE_TYPE_WIFI:
                return dev_path
        except Exception:
            continue
    return None


def _known_ssids(bus) -> set[str]:
    known: set[str] = set()
    try:
        import dbus
        settings_obj = bus.get_object(NM_SERVICE, NM_SETTINGS_PATH)
        for conn_path in dbus.Interface(settings_obj, NM_SETTINGS_IFACE).ListConnections():
            try:
                conn = bus.get_object(NM_SERVICE, conn_path)
                s = dbus.Interface(conn, NM_CONN_IFACE).GetSettings()
                if str(s.get("connection", {}).get("type", "")) == "802-11-wireless":
                    ssid_bytes = s.get("802-11-wireless", {}).get("ssid", [])
                    known.add(bytes(ssid_bytes).decode("utf-8", errors="replace"))
            except Exception:
                continue
    except Exception as exc:
        logger.debug("Could not list known connections: %s", exc)
    return known


def _saved_conn_for_ssid(bus, ssid: str):
    try:
        import dbus
        settings_obj = bus.get_object(NM_SERVICE, NM_SETTINGS_PATH)
        for conn_path in dbus.Interface(settings_obj, NM_SETTINGS_IFACE).ListConnections():
            try:
                conn = bus.get_object(NM_SERVICE, conn_path)
                s = dbus.Interface(conn, NM_CONN_IFACE).GetSettings()
                if str(s.get("connection", {}).get("type", "")) == "802-11-wireless":
                    ssid_bytes = s.get("802-11-wireless", {}).get("ssid", [])
                    if bytes(ssid_bytes).decode("utf-8", errors="replace") == ssid:
                        return conn_path
            except Exception:
                continue
    except Exception as exc:
        logger.debug("Could not look up saved connection for %r: %s", ssid, exc)
    return None


def _ipv4_address_for_device(bus, dev) -> Optional[str]:
    try:
        import dbus

        props = dbus.Interface(dev, DBUS_PROPS_IFACE)
        config_path = str(props.Get(NM_DEVICE_IFACE, "Ip4Config"))
        if config_path == "/":
            return None

        config = bus.get_object(NM_SERVICE, config_path)
        address_data = dbus.Interface(config, DBUS_PROPS_IFACE).Get(
            NM_IP4_CONFIG_IFACE, "AddressData"
        )
        for entry in address_data:
            address = str(entry.get("address", "")).strip()
            if address:
                return address
    except Exception as exc:
        logger.debug("Could not read WiFi IPv4 address: %s", exc)
    return None


def get_wifi_status() -> WifiStatus:
    try:
        import dbus
        bus = _bus()
        nm = bus.get_object(NM_SERVICE, NM_PATH)
        nm_props = dbus.Interface(nm, DBUS_PROPS_IFACE)
        enabled = bool(nm_props.Get(NM_IFACE, "WirelessEnabled"))

        wifi_path = _find_wifi_device(bus)
        if not wifi_path:
            return WifiStatus(available=False, enabled=False, connected=False)

        dev = bus.get_object(NM_SERVICE, wifi_path)
        active_ap = dbus.Interface(dev, DBUS_PROPS_IFACE).Get(NM_WIRELESS_IFACE, "ActiveAccessPoint")

        ssid = None
        ip_address = _ipv4_address_for_device(bus, dev)
        if str(active_ap) != "/":
            ap = bus.get_object(NM_SERVICE, active_ap)
            ssid_bytes = dbus.Interface(ap, DBUS_PROPS_IFACE).Get(NM_AP_IFACE, "Ssid")
            ssid = bytes(ssid_bytes).decode("utf-8", errors="replace")

        return WifiStatus(
            available=True,
            enabled=enabled,
            connected=ssid is not None,
            ssid=ssid,
            ip_address=ip_address,
        )
    except Exception as exc:
        logger.warning("WiFi status error: %s", exc)
        return WifiStatus(available=False, enabled=False, connected=False, error=str(exc))


def scan_networks() -> list[AccessPoint]:
    try:
        import dbus
        bus = _bus()
        wifi_path = _find_wifi_device(bus)
        if not wifi_path:
            return []

        dev = bus.get_object(NM_SERVICE, wifi_path)
        wireless = dbus.Interface(dev, NM_WIRELESS_IFACE)
        dev_props = dbus.Interface(dev, DBUS_PROPS_IFACE)

        # RequestScan may fail if a scan was recently done (rate-limited to ~30s); that's fine.
        try:
            wireless.RequestScan(dbus.Dictionary({}, signature="sv"))
        except dbus.exceptions.DBusException as exc:
            logger.debug("RequestScan skipped: %s", exc)

        active_ap = str(dev_props.Get(NM_WIRELESS_IFACE, "ActiveAccessPoint"))
        known = _known_ssids(bus)

        seen: set[str] = set()
        results: list[AccessPoint] = []
        for ap_path in wireless.GetAllAccessPoints():
            try:
                ap = bus.get_object(NM_SERVICE, ap_path)
                ap_props = dbus.Interface(ap, DBUS_PROPS_IFACE).GetAll(NM_AP_IFACE)
                ssid = bytes(ap_props["Ssid"]).decode("utf-8", errors="replace").strip()
                if not ssid or ssid in seen:
                    continue
                seen.add(ssid)
                flags = int(ap_props.get("Flags", 0))
                wpa = int(ap_props.get("WpaFlags", 0))
                rsn = int(ap_props.get("RsnFlags", 0))
                secured = bool(flags & NM_802_11_AP_FLAGS_PRIVACY) or bool(wpa) or bool(rsn)
                results.append(AccessPoint(
                    ssid=ssid,
                    strength=int(ap_props.get("Strength", 0)),
                    secured=secured,
                    in_use=str(ap_path) == active_ap,
                    known=ssid in known,
                ))
            except Exception as exc:
                logger.debug("Skipping AP at %s: %s", ap_path, exc)

        results.sort(key=lambda a: (-a.in_use, -a.strength))
        return results
    except Exception as exc:
        logger.warning("WiFi scan error: %s", exc)
        return []


def connect_network(ssid: str, password: str | None) -> None:
    import dbus
    bus = _bus()
    nm = bus.get_object(NM_SERVICE, NM_PATH)
    nm_iface = dbus.Interface(nm, NM_IFACE)

    wifi_path = _find_wifi_device(bus)
    if not wifi_path:
        raise RuntimeError("No WiFi adapter found")

    # Activate an existing saved profile if no new password is being supplied.
    if not password:
        saved = _saved_conn_for_ssid(bus, ssid)
        if saved:
            nm_iface.ActivateConnection(
                dbus.ObjectPath(saved),
                dbus.ObjectPath(wifi_path),
                dbus.ObjectPath("/"),
            )
            return

    conn: dict = {
        "connection": dbus.Dictionary({
            "id": dbus.String(ssid),
            "type": dbus.String("802-11-wireless"),
        }, signature="sv"),
        "802-11-wireless": dbus.Dictionary({
            "ssid": dbus.Array([dbus.Byte(c) for c in ssid.encode("utf-8")], signature="y"),
            "mode": dbus.String("infrastructure"),
        }, signature="sv"),
        "ipv4": dbus.Dictionary({"method": dbus.String("auto")}, signature="sv"),
        "ipv6": dbus.Dictionary({"method": dbus.String("ignore")}, signature="sv"),
    }

    if password:
        conn["802-11-wireless"]["security"] = dbus.String("802-11-wireless-security")
        conn["802-11-wireless-security"] = dbus.Dictionary({
            "key-mgmt": dbus.String("wpa-psk"),
            "psk": dbus.String(password),
        }, signature="sv")

    nm_iface.AddAndActivateConnection(
        dbus.Dictionary(conn, signature="sa{sv}"),
        dbus.ObjectPath(wifi_path),
        dbus.ObjectPath("/"),
    )


def disconnect_network() -> None:
    import dbus
    bus = _bus()
    wifi_path = _find_wifi_device(bus)
    if not wifi_path:
        raise RuntimeError("No WiFi adapter found")

    dev = bus.get_object(NM_SERVICE, wifi_path)
    dbus.Interface(dev, NM_DEVICE_IFACE).Disconnect()
