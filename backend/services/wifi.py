from __future__ import annotations

import asyncio
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
NM_ACTIVE_CONN_IFACE = "org.freedesktop.NetworkManager.Connection.Active"
DBUS_PROPS_IFACE = "org.freedesktop.DBus.Properties"

NM_DEVICE_TYPE_WIFI = 2
NM_802_11_AP_FLAGS_PRIVACY = 0x1

# NMActiveConnectionState
NM_ACTIVE_CONNECTION_STATE_ACTIVATING = 1
NM_ACTIVE_CONNECTION_STATE_ACTIVATED = 2
NM_ACTIVE_CONNECTION_STATE_DEACTIVATED = 4

# NMDeviceStateReason values worth translating into human-readable errors.
_DEVICE_STATE_REASONS = {
    7: "incorrect Wi-Fi password",
    8: "incorrect Wi-Fi password",
    9: "incorrect Wi-Fi password",
    39: "incorrect Wi-Fi password",
    11: "association with the access point timed out",
    12: "association with the access point failed",
    13: "authentication with the access point failed",
    15: "the network was not found",
}

# How long to wait for a connection to fully activate (association + DHCP).
ACTIVATION_TIMEOUT_S = 25.0


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

        ap_active = is_ap_active(bus)

        ssid = None
        ip_address = _ipv4_address_for_device(bus, dev)
        if str(active_ap) != "/" and not ap_active:
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


_cached_networks: list[AccessPoint] = []


def scan_networks() -> list[AccessPoint]:
    global _cached_networks
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

        # Filter out the onboarding hotspot from results
        real_results = [r for r in results if r.ssid != "nimbus"]

        if real_results:
            _cached_networks = real_results
            return real_results

        # If we only found 'nimbus' (or nothing) because we are in AP mode,
        # return the cached results so the user can see available networks.
        return _cached_networks
    except Exception as exc:
        logger.warning("WiFi scan error: %s", exc)
        return _cached_networks


def _device_failure_reason(bus, wifi_path) -> str | None:
    """Translate the wifi device's current StateReason into a human message."""
    try:
        import dbus
        dev = bus.get_object(NM_SERVICE, wifi_path)
        state_reason = dbus.Interface(dev, DBUS_PROPS_IFACE).Get(NM_DEVICE_IFACE, "StateReason")
        reason = int(state_reason[1])
        return _DEVICE_STATE_REASONS.get(reason)
    except Exception as exc:
        logger.debug("Could not read device state reason: %s", exc)
        return None


def _wait_for_activation(bus, active_path, wifi_path) -> None:
    """Block until the active connection reaches ACTIVATED, or raise on failure.

    NetworkManager's Add/ActivateConnection calls return as soon as activation
    *starts*; association, authentication and DHCP all happen asynchronously
    afterwards. Without waiting, a wrong password or DHCP timeout looks like a
    silent success to the caller. Poll the active-connection state so we can
    report a real error back to the UI.
    """
    import time

    import dbus
    if not active_path or str(active_path) == "/":
        raise RuntimeError("NetworkManager did not start the connection")

    deadline = time.monotonic() + ACTIVATION_TIMEOUT_S
    active = bus.get_object(NM_SERVICE, active_path)
    props = dbus.Interface(active, DBUS_PROPS_IFACE)
    while time.monotonic() < deadline:
        try:
            state = int(props.Get(NM_ACTIVE_CONN_IFACE, "State"))
        except dbus.exceptions.DBusException:
            # The active connection object disappeared — activation failed and
            # NM tore it down. Fall back to the device state reason.
            reason = _device_failure_reason(bus, wifi_path)
            raise RuntimeError(f"Connection failed: {reason}" if reason else "Connection failed")
        if state == NM_ACTIVE_CONNECTION_STATE_ACTIVATED:
            return
        if state == NM_ACTIVE_CONNECTION_STATE_DEACTIVATED:
            reason = _device_failure_reason(bus, wifi_path)
            raise RuntimeError(f"Connection failed: {reason}" if reason else "Connection failed")
        time.sleep(0.5)

    reason = _device_failure_reason(bus, wifi_path)
    raise RuntimeError(
        f"Timed out connecting: {reason}" if reason else "Timed out connecting to the network"
    )


def connect_network(ssid: str, password: str | None) -> None:
    """Connect to a Wi-Fi network, raising RuntimeError with a usable message
    on any failure (bad password, NM/permission errors, timeout) so the API
    can surface it to the UI instead of returning an opaque 500."""
    import dbus
    try:
        _connect_network(ssid, password)
    except RuntimeError:
        raise
    except dbus.exceptions.DBusException as exc:
        logger.warning("WiFi connect D-Bus error for %r: %s", ssid, exc)
        raise RuntimeError(f"NetworkManager error: {exc.get_dbus_message() or exc}")


def _connect_network(ssid: str, password: str | None) -> None:
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
            active_path = nm_iface.ActivateConnection(
                dbus.ObjectPath(saved),
                dbus.ObjectPath(wifi_path),
                dbus.ObjectPath("/"),
            )
            _wait_for_activation(bus, active_path, wifi_path)
            return

    conn: dict = {
        "connection": dbus.Dictionary({
            "id": dbus.String(ssid),
            "type": dbus.String("802-11-wireless"),
            "mdns": dbus.Int32(2),
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

    conn_path, active_path = nm_iface.AddAndActivateConnection(
        dbus.Dictionary(conn, signature="sa{sv}"),
        dbus.ObjectPath(wifi_path),
        dbus.ObjectPath("/"),
    )
    try:
        _wait_for_activation(bus, active_path, wifi_path)
    except RuntimeError:
        # Activation failed (e.g. wrong password). Remove the profile we just
        # created so it doesn't linger and auto-reconnect-fail or accumulate.
        try:
            conn_obj = bus.get_object(NM_SERVICE, conn_path)
            dbus.Interface(conn_obj, NM_CONN_IFACE).Delete()
        except Exception as exc:
            logger.debug("Could not delete failed connection profile: %s", exc)
        raise


def disconnect_network() -> None:
    import dbus
    bus = _bus()
    wifi_path = _find_wifi_device(bus)
    if not wifi_path:
        raise RuntimeError("No WiFi adapter found")

    dev = bus.get_object(NM_SERVICE, wifi_path)
    dbus.Interface(dev, NM_DEVICE_IFACE).Disconnect()


def is_ap_active(bus=None) -> bool:
    import dbus
    if bus is None:
        try:
            bus = _bus()
        except Exception:
            return False
    try:
        nm = bus.get_object(NM_SERVICE, NM_PATH)
        active_connections = dbus.Interface(nm, DBUS_PROPS_IFACE).Get(NM_IFACE, "ActiveConnections")
        for conn_path in active_connections:
            try:
                conn_obj = bus.get_object(NM_SERVICE, conn_path)
                props = dbus.Interface(conn_obj, DBUS_PROPS_IFACE)
                settings_path = props.Get(NM_ACTIVE_CONN_IFACE, "Connection")
                settings_obj = bus.get_object(NM_SERVICE, settings_path)
                settings = dbus.Interface(settings_obj, NM_CONN_IFACE).GetSettings()
                conn_id = str(settings.get("connection", {}).get("id", ""))
                conn_type = str(settings.get("connection", {}).get("type", ""))
                mode = str(settings.get("802-11-wireless", {}).get("mode", ""))
                if conn_id == "nimbus" and conn_type == "802-11-wireless" and mode == "ap":
                    return True
            except Exception:
                continue
    except Exception as exc:
        logger.debug("Error checking if AP is active: %s", exc)
    return False


def _delete_existing_ap_profiles(bus) -> None:
    import dbus
    try:
        settings_obj = bus.get_object(NM_SERVICE, NM_SETTINGS_PATH)
        settings_iface = dbus.Interface(settings_obj, NM_SETTINGS_IFACE)
        for conn_path in settings_iface.ListConnections():
            try:
                conn_obj = bus.get_object(NM_SERVICE, conn_path)
                conn_iface = dbus.Interface(conn_obj, NM_CONN_IFACE)
                s = conn_iface.GetSettings()
                conn_id = str(s.get("connection", {}).get("id", ""))
                conn_type = str(s.get("connection", {}).get("type", ""))
                mode = str(s.get("802-11-wireless", {}).get("mode", ""))
                if conn_id == "nimbus" and conn_type == "802-11-wireless" and mode == "ap":
                    logger.info("Deleting existing AP connection profile: %s", conn_path)
                    conn_iface.Delete()
            except Exception:
                continue
    except Exception as exc:
        logger.debug("Error while deleting old AP profiles: %s", exc)


def start_ap() -> None:
    import dbus
    try:
        bus = _bus()
    except Exception as exc:
        logger.error("D-Bus connection failed, cannot start AP: %s", exc)
        return

    if is_ap_active(bus):
        logger.info("Nimbus AP is already active")
        return

    wifi_path = _find_wifi_device(bus)
    if not wifi_path:
        logger.warning("No WiFi adapter found, cannot start AP")
        return

    logger.info("Starting Nimbus hostap Access Point...")

    # Delete any existing AP connection profiles to keep things clean.
    _delete_existing_ap_profiles(bus)

    # Define connection settings for AP mode.
    # We use "shared" method for IPv4 to activate dnsmasq/DHCP on the interface.
    conn = {
        "connection": dbus.Dictionary({
            "id": dbus.String("nimbus"),
            "type": dbus.String("802-11-wireless"),
            "autoconnect": dbus.Boolean(False),
            "mdns": dbus.Int32(2),
        }, signature="sv"),
        "802-11-wireless": dbus.Dictionary({
            "ssid": dbus.Array([dbus.Byte(c) for c in b"nimbus"], signature="y"),
            "mode": dbus.String("ap"),
            "band": dbus.String("bg"),
        }, signature="sv"),
        "ipv4": dbus.Dictionary({
            "method": dbus.String("shared"),
        }, signature="sv"),
        "ipv6": dbus.Dictionary({
            "method": dbus.String("ignore"),
        }, signature="sv"),
    }

    try:
        nm = bus.get_object(NM_SERVICE, NM_PATH)
        nm_iface = dbus.Interface(nm, NM_IFACE)
        conn_path, active_path = nm_iface.AddAndActivateConnection(
            dbus.Dictionary(conn, signature="sa{sv}"),
            dbus.ObjectPath(wifi_path),
            dbus.ObjectPath("/"),
        )
        logger.info("Nimbus AP connection created and activation initiated (AP connection: %s)", active_path)
    except Exception as exc:
        logger.error("Failed to start AP: %s", exc)


def stop_ap() -> None:
    import dbus
    try:
        bus = _bus()
    except Exception as exc:
        logger.error("D-Bus connection failed, cannot stop AP: %s", exc)
        return

    logger.info("Stopping Nimbus hostap Access Point...")
    
    try:
        nm = bus.get_object(NM_SERVICE, NM_PATH)
        active_connections = dbus.Interface(nm, DBUS_PROPS_IFACE).Get(NM_IFACE, "ActiveConnections")
        for conn_path in active_connections:
            try:
                conn_obj = bus.get_object(NM_SERVICE, conn_path)
                props = dbus.Interface(conn_obj, DBUS_PROPS_IFACE)
                settings_path = props.Get(NM_ACTIVE_CONN_IFACE, "Connection")
                settings_obj = bus.get_object(NM_SERVICE, settings_path)
                settings_val = dbus.Interface(settings_obj, NM_CONN_IFACE).GetSettings()
                conn_id = str(settings_val.get("connection", {}).get("id", ""))
                conn_type = str(settings_val.get("connection", {}).get("type", ""))
                mode = str(settings_val.get("802-11-wireless", {}).get("mode", ""))
                if conn_id == "nimbus" and conn_type == "802-11-wireless" and mode == "ap":
                    logger.info("Deactivating active AP connection: %s", conn_path)
                    dbus.Interface(nm, NM_IFACE).DeactivateConnection(conn_path)
            except Exception:
                continue
    except Exception as exc:
        logger.debug("Error while deactivating AP connection: %s", exc)

    # Clean up settings connection profiles
    _delete_existing_ap_profiles(bus)


class CaptiveDNSProtocol(asyncio.DatagramProtocol):
    def __init__(self, target_ip: str):
        self.target_ip = target_ip

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        try:
            reply = self.build_reply(data)
            self.transport.sendto(reply, addr)
        except Exception as exc:
            logger.debug("Error building DNS reply: %s", exc)

    def build_reply(self, data):
        if len(data) < 12:
            raise ValueError("Data too short")

        transaction_id = data[:2]
        flags = b"\x81\x80"
        qdcount = data[4:6]
        nscount = b"\x00\x00"
        arcount = b"\x00\x00"
        
        end = 12
        while end < len(data):
            length = data[end]
            if length == 0:
                end += 1
                break
            if length & 0xC0 == 0xC0:
                end += 2
                break
            end += 1 + length
        
        if end + 4 > len(data):
            raise ValueError("Truncated question section")

        question = data[12:end+4]
        qtype = data[end : end+2]
        
        # We only answer A queries (type 1) with our IPv4 address.
        # For other queries (like AAAA or HTTPS), we return NODATA (success with 0 answers)
        # so the client falls back to IPv4 A queries.
        if qtype == b"\x00\x01":
            ancount = b"\x00\x01"
            answer_name = b"\xc0\x0c"
            answer_type = b"\x00\x01"
            answer_class = b"\x00\x01"
            answer_ttl = b"\x00\x00\x00\x3c"
            answer_rdlength = b"\x00\x04"
            ip_bytes = bytes(int(x) for x in self.target_ip.split("."))
            answers = answer_name + answer_type + answer_class + answer_ttl + answer_rdlength + ip_bytes
        else:
            ancount = b"\x00\x00"
            answers = b""
            
        return transaction_id + flags + qdcount + ancount + nscount + arcount + question + answers


_dns_server_transport = None

async def start_dns_server(ip: str) -> None:
    global _dns_server_transport
    if _dns_server_transport:
        return
    try:
        loop = asyncio.get_running_loop()
        transport, protocol = await loop.create_datagram_endpoint(
            lambda: CaptiveDNSProtocol(ip),
            local_addr=("0.0.0.0", 5300)
        )
        _dns_server_transport = transport
        logger.info("Captive portal DNS server started on 0.0.0.0:5300")
    except Exception as exc:
        logger.error("Failed to start captive portal DNS server: %s", exc)


async def stop_dns_server() -> None:
    global _dns_server_transport
    if _dns_server_transport:
        try:
            _dns_server_transport.close()
            logger.info("Captive portal DNS server stopped")
        except Exception as exc:
            logger.debug("Error stopping DNS server: %s", exc)
        _dns_server_transport = None


def _manage_dns_redirect(iface: str, ip: str, add: bool) -> None:
    import os
    import subprocess
    
    snap_dir = os.environ.get("SNAP")
    iptables_path = ""
    env = os.environ.copy()
    
    if snap_dir:
        for candidate in ["/usr/sbin/iptables-nft", "/usr/sbin/iptables", "/sbin/iptables"]:
            path = os.path.join(snap_dir, candidate.lstrip("/"))
            if os.path.exists(path):
                iptables_path = path
                break
        
        for libdir_rel in [
            "usr/lib/x86_64-linux-gnu/xtables",
            "usr/lib/aarch64-linux-gnu/xtables",
            "usr/lib/arm-linux-gnueabihf/xtables",
            "usr/lib/xtables",
        ]:
            libdir = os.path.join(snap_dir, libdir_rel)
            if os.path.exists(libdir):
                env["XTABLES_LIBDIR"] = libdir
                break

    if not iptables_path:
        iptables_path = "/sbin/iptables"
        if not os.path.exists(iptables_path):
            if os.path.exists("/usr/sbin/iptables"):
                iptables_path = "/usr/sbin/iptables"
            else:
                iptables_path = "iptables"

    action = "-I" if add else "-D"
    cmd = [
        iptables_path, "-t", "nat", action, "PREROUTING",
        "-i", iface, "-p", "udp", "--dport", "53",
        "-j", "DNAT", "--to-destination", f"{ip}:5300"
    ]
    try:
        result = subprocess.run(cmd, env=env, capture_output=True, text=True, check=True)
        logger.info("Successfully %s DNS redirect rule on %s for %s", "added" if add else "removed", iface, ip)
    except Exception as exc:
        stderr = getattr(exc, "stderr", "") or str(exc)
        logger.error("Failed to %s DNS redirect rule on %s: %s", "add" if add else "remove", iface, stderr)


async def async_start_ap() -> None:
    # DNS captive-portal redirect is handled by NM's own dnsmasq via
    # address=/#/<gw-ip> written to dnsmasq-shared.d by nimbus-connect.service.
    # No separate DNS server or iptables rule is needed.
    await asyncio.to_thread(start_ap)


async def async_stop_ap() -> None:
    await asyncio.to_thread(stop_ap)


async def handover_ap_to_wifi(ssid: str, password: str | None) -> None:
    logger.info("Handing over AP to client Wi-Fi: %s", ssid)
    # 1. Sleep for 2 seconds to let the response reach the client browser.
    await asyncio.sleep(2.0)
    
    # 2. Stop the AP
    try:
        await async_stop_ap()
    except Exception as exc:
        logger.error("Failed to stop AP during handover: %s", exc)
        
    # 3. Connect to the new Wi-Fi
    try:
        await asyncio.to_thread(connect_network, ssid, password)
        logger.info("Successfully transitioned to client Wi-Fi: %s", ssid)
    except Exception as exc:
        logger.warning("Handover connect failed: %s. Re-activating AP...", exc)
        # 4. Fallback: Re-activate AP since connection failed
        try:
            await async_start_ap()
        except Exception as start_ap_exc:
            logger.error("Failed to re-activate AP after connection failure: %s", start_ap_exc)


async def check_and_manage_ap_on_startup() -> None:
    # Wait for NetworkManager to settle.
    await asyncio.sleep(10.0)

    from services.device import is_oobe_complete
    if is_oobe_complete():
        logger.info("OOBE is complete, skipping startup AP check")
        return

    from services.network import is_online
    if is_online():
        logger.info("Device is online on startup, skipping AP check")
        return

    try:
        bus = _bus()
        if is_ap_active(bus):
            logger.info("Nimbus AP is already active on startup")
        else:
            wifi_path = _find_wifi_device(bus)
            if wifi_path:
                logger.info("Device is offline and OOBE is incomplete; scanning then starting AP...")
                await asyncio.to_thread(scan_networks)
                await async_start_ap()
            else:
                logger.warning("No WiFi adapter found on startup, cannot start AP")
                return
    except Exception as exc:
        logger.error("Error during startup AP check: %s", exc)
        return

    # Monitor the AP while OOBE is pending and restart it if it goes down.
    # On first boot, nimbus-connect.service restarts NetworkManager to apply the
    # captive-portal dnsmasq config (address=/#/<gw>) to dnsmasq-shared.d, which
    # tears down our AP. Detect the downtime and restart; the new NM instance will
    # pick up the dnsmasq captive-portal config automatically.
    logger.info("AP monitor started — will restart AP if it goes down before OOBE completes")
    for _ in range(120):  # monitor for up to 10 minutes (120 × 5 s)
        await asyncio.sleep(5.0)
        from services.device import is_oobe_complete
        from services.network import is_online
        if is_oobe_complete() or is_online():
            logger.info("OOBE complete or device online — stopping AP monitor")
            return
        try:
            if not is_ap_active():
                logger.info("AP went down during OOBE; waiting for NM to settle before restarting...")
                await asyncio.sleep(10.0)  # give NM time to fully restart (~10 s observed)
                if not is_ap_active():
                    logger.info("Restarting AP after NM restart...")
                    await async_start_ap()
        except Exception as exc:
            logger.debug("AP monitor error (NM may still be restarting): %s", exc)
