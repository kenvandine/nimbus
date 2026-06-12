"""Nimbus LXC agent daemon.

Runs as a systemd service inside the LXC container. On each tick it:
  - Ensures all installed Docker app containers are up (restarts any that stopped).
  - Ensures Docker daemon.json has reliable public DNS servers (fixes the
    lxdbr0/systemd-resolved chain that intermittently breaks image pulls).

Exposes a minimal HTTP API on port 9001 for status queries and future
snap-management commands issued by the host nimbus.

Run directly:  python /opt/nimbus/backend/agent/daemon.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path

DAEMON_VERSION = "9"
INSTALLED_DIR = Path("/var/lib/nimbus/installed")
DOCKER_DAEMON_JSON = Path("/etc/docker/daemon.json")
RESOLVED_DROPIN_DIR = Path("/etc/systemd/resolved.conf.d")
RESOLVED_DROPIN = RESOLVED_DROPIN_DIR / "nimbus-dns.conf"
DNS_SERVERS = ["1.1.1.1", "8.8.8.8"]
DNS_FALLBACK_SERVERS = ["1.0.0.1", "8.8.4.4"]
DNS_CHECK_HOST = "registry-1.docker.io"
APP_CHECK_INTERVAL = 30   # seconds between app health sweeps
DNS_CHECK_INTERVAL = 60   # seconds between DNS health checks
HTTP_PORT = 9001

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("nimbus-lxc-agent")

# Shared state updated by background loops; read by the HTTP handler.
_state: dict = {
    "version": DAEMON_VERSION,
    "dns_ok": True,
    "apps": {},
}


# ── Docker app health ──────────────────────────────────────────────────────────

def _installed_apps() -> list[tuple[str, Path]]:
    """Return (app_id, compose_path) for every installed app."""
    if not INSTALLED_DIR.exists():
        return []
    return sorted(
        (d.name, d / "docker-compose.yml")
        for d in INSTALLED_DIR.iterdir()
        if d.is_dir() and (d / "docker-compose.yml").exists()
    )


async def _app_running(app_id: str, compose_file: Path) -> bool:
    env_file = compose_file.parent / ".env"
    cmd = ["docker", "compose", "-p", app_id, "-f", str(compose_file)]
    if env_file.exists():
        cmd += ["--env-file", str(env_file)]
    cmd += ["ps", "--format", "json"]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    stdout, _ = await proc.communicate()

    containers: list[dict] = []
    for line in (stdout or b"").decode().strip().splitlines():
        try:
            containers.append(json.loads(line))
        except json.JSONDecodeError:
            pass

    return bool(containers) and all(c.get("State") == "running" for c in containers)


async def _app_has_containers(app_id: str, compose_file: Path) -> bool:
    """Return True if any container (running or stopped) exists for this app.

    A False result means the image was never pulled — the install flow hasn't
    completed yet. The daemon must not attempt to start such apps.
    """
    env_file = compose_file.parent / ".env"
    cmd = ["docker", "compose", "-p", app_id, "-f", str(compose_file)]
    if env_file.exists():
        cmd += ["--env-file", str(env_file)]
    cmd += ["ps", "--all", "--format", "json"]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    stdout, _ = await proc.communicate()

    for line in (stdout or b"").decode().strip().splitlines():
        try:
            json.loads(line)
            return True
        except json.JSONDecodeError:
            pass
    return False


async def _start_app(app_id: str, compose_file: Path) -> None:
    env_file = compose_file.parent / ".env"
    cmd = ["docker", "compose", "-p", app_id, "-f", str(compose_file)]
    if env_file.exists():
        cmd += ["--env-file", str(env_file)]
    # Never pull during health-check restarts — pulling is the install flow's job.
    cmd += ["up", "-d", "--remove-orphans", "--pull", "never"]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        logger.warning("docker compose up failed for %s: %s", app_id, stderr.decode().strip())


async def _check_apps() -> None:
    for app_id, compose_file in _installed_apps():
        try:
            if not await _app_has_containers(app_id, compose_file):
                # Image never pulled; leave it to the nimbus install flow.
                _state["apps"][app_id] = {"running": False, "pending_install": True}
                continue
            running = await _app_running(app_id, compose_file)
            if not running:
                logger.info("App %s is not fully running — starting", app_id)
                await _start_app(app_id, compose_file)
                running = await _app_running(app_id, compose_file)
            _state["apps"][app_id] = {"running": running}
        except Exception:
            logger.exception("Error checking app %s", app_id)
            _state["apps"].setdefault(app_id, {})["error"] = True


async def _app_health_loop() -> None:
    while True:
        try:
            await _check_apps()
        except Exception:
            logger.exception("Unhandled error in app health loop")
        await asyncio.sleep(APP_CHECK_INTERVAL)


# ── DNS / Docker daemon health ─────────────────────────────────────────────────

async def _dns_resolves() -> bool:
    """Return True if DNS resolves, retrying up to 3 times before concluding failure."""
    for attempt in range(3):
        proc = await asyncio.create_subprocess_exec(
            "getent", "hosts", DNS_CHECK_HOST,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.communicate()
        if proc.returncode == 0:
            return True
        if attempt < 2:
            await asyncio.sleep(5)
    return False


async def _default_interface() -> str | None:
    """Return the name of the default-route network interface, or None."""
    proc = await asyncio.create_subprocess_exec(
        "ip", "-4", "route", "show", "default",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    stdout, _ = await proc.communicate()
    parts = stdout.decode().split()
    try:
        return parts[parts.index("dev") + 1]
    except (ValueError, IndexError):
        return None


async def _fix_system_dns() -> bool:
    """Fix DNS by bypassing the systemd-resolved stub with a static resolv.conf.

    The stub resolver's EDNS0 feature-set negotiation with DNS servers can
    take several minutes of TCP/UDP cycling before settling.  During bootstrap
    this breaks docker pulls.  Writing a static /etc/resolv.conf that points
    directly at public DNS servers bypasses the stub entirely so glibc queries
    reach the servers immediately.

    We also write a systemd-resolved drop-in so resolved itself uses public
    DNS (for hostname lookups that go through NSS-resolve rather than glibc),
    and configure per-interface DNS via resolvectl for immediate effect.
    """
    static_resolv = f"nameserver {DNS_SERVERS[0]}\nnameserver {DNS_SERVERS[1]}\n"
    dropin_content = (
        "[Resolve]\n"
        f"FallbackDNS={' '.join(DNS_FALLBACK_SERVERS)}\n"
        "DNSSEC=no\n"
    )
    try:
        # Write static resolv.conf — bypasses the stub resolver and its slow
        # feature-set negotiation.  Networkd does not restore the symlink on
        # DHCP renewals so this persists until something explicitly resets it.
        resolv_conf = Path("/etc/resolv.conf")
        if resolv_conf.is_symlink() or not resolv_conf.exists() or resolv_conf.read_text() != static_resolv:
            resolv_conf.unlink(missing_ok=True)
            resolv_conf.write_text(static_resolv)
            logger.info("Wrote static /etc/resolv.conf pointing to public DNS servers")

        # Drop-in: configure resolved's fallback and disable DNSSEC.
        RESOLVED_DROPIN_DIR.mkdir(parents=True, exist_ok=True)
        dropin_changed = not RESOLVED_DROPIN.exists() or RESOLVED_DROPIN.read_text() != dropin_content
        if dropin_changed:
            RESOLVED_DROPIN.write_text(dropin_content)
            logger.info("Wrote systemd-resolved drop-in (FallbackDNS + DNSSEC=no)")
            proc = await asyncio.create_subprocess_exec(
                "systemctl", "restart", "systemd-resolved",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.communicate()
            logger.info("Restarted systemd-resolved")

        # Also push public DNS directly to the interface so resolved queries
        # use them for any lookups that go through the stub.
        iface = await _default_interface()
        if iface:
            for cmd in (
                ["resolvectl", "dns", iface, *DNS_SERVERS],
                ["resolvectl", "domain", iface, "~."],
            ):
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await proc.communicate()
            logger.info("Set per-interface DNS on %s via resolvectl", iface)

        return True
    except Exception as exc:
        logger.error("Failed to fix system DNS: %s", exc)
        return False


async def _ensure_docker_dns() -> bool:
    """Write public DNS into daemon.json and restart Docker if the entry is missing."""
    try:
        current = json.loads(DOCKER_DAEMON_JSON.read_text()) if DOCKER_DAEMON_JSON.exists() else {}
    except (json.JSONDecodeError, OSError):
        current = {}

    if current.get("dns") == DNS_SERVERS:
        return False

    logger.info("Updating /etc/docker/daemon.json with public DNS servers")
    DOCKER_DAEMON_JSON.parent.mkdir(parents=True, exist_ok=True)
    DOCKER_DAEMON_JSON.write_text(json.dumps({**current, "dns": DNS_SERVERS}, indent=2) + "\n")

    proc = await asyncio.create_subprocess_exec(
        "systemctl", "restart", "docker",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.communicate()
    logger.info("Docker restarted with updated DNS config")
    return True


async def _dns_health_loop() -> None:
    # Give resolved time to settle before the first check so we don't
    # disrupt the EDNS0 feature negotiation that happens at startup.
    await asyncio.sleep(30)
    while True:
        try:
            ok = await _dns_resolves()
            if not ok:
                logger.warning("DNS resolution for %s failed — fixing system and Docker DNS", DNS_CHECK_HOST)
                await _fix_system_dns()
                await _ensure_docker_dns()
                await asyncio.sleep(15)  # let resolvectl changes take effect
                ok = await _dns_resolves()
                if not ok:
                    logger.error("DNS still failing after fix attempt")
            _state["dns_ok"] = ok
        except Exception:
            logger.exception("Unhandled error in DNS health loop")
        await asyncio.sleep(DNS_CHECK_INTERVAL)


# ── Snap management (future) ───────────────────────────────────────────────────

async def _snap_install(name: str, channel: str = "stable", classic: bool = False) -> dict:
    cmd = ["snap", "install", name, "--channel", channel]
    if classic:
        cmd.append("--classic")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return {
        "ok": proc.returncode == 0,
        "stdout": stdout.decode(),
        "stderr": stderr.decode(),
    }


async def _snap_remove(name: str) -> dict:
    proc = await asyncio.create_subprocess_exec(
        "snap", "remove", name,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return {
        "ok": proc.returncode == 0,
        "stdout": stdout.decode(),
        "stderr": stderr.decode(),
    }


async def _snap_refresh(name: str, channel: str | None = None) -> dict:
    cmd = ["snap", "refresh", name]
    if channel:
        cmd += ["--channel", channel]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return {
        "ok": proc.returncode == 0,
        "stdout": stdout.decode(),
        "stderr": stderr.decode(),
    }


async def _snap_list() -> list[dict]:
    """Return list of all installed snaps via `snap list`."""
    proc = await asyncio.create_subprocess_exec(
        "snap", "list", "--unicode=never",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    stdout, _ = await proc.communicate()
    snaps = []
    lines = stdout.decode().splitlines()
    for line in lines[1:]:
        parts = line.split()
        if len(parts) >= 5:
            snaps.append({
                "name": parts[0],
                "version": parts[1],
                "revision": parts[2],
                "tracking": parts[3],
                "publisher": parts[4],
                "notes": parts[5] if len(parts) > 5 else "",
            })
    return snaps


async def _snap_info(name: str) -> dict | None:
    """Return info for a specific snap, or None if not installed."""
    proc = await asyncio.create_subprocess_exec(
        "snap", "list", "--unicode=never", name,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    stdout, _ = await proc.communicate()
    if proc.returncode != 0:
        return None
    lines = stdout.decode().splitlines()
    for line in lines[1:]:
        parts = line.split()
        if len(parts) >= 5 and parts[0] == name:
            return {
                "name": parts[0],
                "version": parts[1],
                "revision": parts[2],
                "tracking": parts[3],
                "publisher": parts[4],
                "notes": parts[5] if len(parts) > 5 else "",
                "installed": True,
            }
    return None


# ── HTTP API ───────────────────────────────────────────────────────────────────

async def _read_body(reader: asyncio.StreamReader, headers: dict[str, str]) -> bytes:
    length = int(headers.get("content-length", "0"))
    return await reader.readexactly(length) if length > 0 else b""


async def _route(method: str, path: str, body: bytes) -> tuple[int, dict]:
    if method == "GET" and path == "/health":
        return 200, {"ok": True, "version": DAEMON_VERSION, "dns_ok": _state["dns_ok"]}

    if method == "GET" and path == "/apps":
        return 200, {"apps": _state["apps"]}

    # Snap management endpoints
    if method == "POST" and path == "/snaps/install":
        try:
            req = json.loads(body)
        except json.JSONDecodeError:
            return 400, {"error": "invalid JSON"}
        name = req.get("name", "").strip()
        if not name:
            return 400, {"error": "name required"}
        classic = bool(req.get("classic", False))
        result = await _snap_install(name, req.get("channel", "stable"), classic=classic)
        return (200 if result["ok"] else 500), result

    if method == "POST" and path == "/snaps/remove":
        try:
            req = json.loads(body)
        except json.JSONDecodeError:
            return 400, {"error": "invalid JSON"}
        name = req.get("name", "").strip()
        if not name:
            return 400, {"error": "name required"}
        result = await _snap_remove(name)
        return (200 if result["ok"] else 500), result

    if method == "POST" and path == "/snaps/refresh":
        try:
            req = json.loads(body)
        except json.JSONDecodeError:
            return 400, {"error": "invalid JSON"}
        name = req.get("name", "").strip()
        if not name:
            return 400, {"error": "name required"}
        result = await _snap_refresh(name, req.get("channel"))
        return (200 if result["ok"] else 500), result

    if method == "GET" and path == "/snaps":
        snaps = await _snap_list()
        return 200, {"snaps": snaps}

    if method == "GET" and path.startswith("/snaps/") and len(path.split("/")) == 3:
        snap_name = path.split("/")[2]
        info = await _snap_info(snap_name)
        if info is None:
            return 404, {"error": "snap not installed", "name": snap_name}
        return 200, info

    return 404, {"error": "not found"}


async def _handle_journal_sse(path: str, writer: asyncio.StreamWriter) -> None:
    """Stream journalctl output as SSE over a persistent connection."""
    lines = 200
    if "?" in path:
        for param in path.split("?", 1)[1].split("&"):
            if param.startswith("lines="):
                try:
                    lines = max(1, min(2000, int(param[6:])))
                except ValueError:
                    pass

    writer.write(
        b"HTTP/1.1 200 OK\r\n"
        b"Content-Type: text/event-stream\r\n"
        b"Cache-Control: no-cache\r\n"
        b"X-Accel-Buffering: no\r\n"
        b"Connection: keep-alive\r\n"
        b"\r\n"
    )
    await writer.drain()

    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            "journalctl", "-u", "nimbus",
            "-f", f"-n{lines}", "--no-pager", "--output=short-iso",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode(errors="replace").rstrip()
            writer.write(f"data: {json.dumps({'line': line})}\n\n".encode())
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.CancelledError):
        pass
    except Exception as exc:
        try:
            writer.write(f"data: {json.dumps({'error': str(exc)})}\n\n".encode())
            await writer.drain()
        except Exception:
            pass
    finally:
        if proc is not None:
            try:
                proc.terminate()
            except Exception:
                pass


async def _handle_http(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
        parts = request_line.decode().strip().split()
        if len(parts) < 2:
            return
        method, path = parts[0], parts[1]

        headers: dict[str, str] = {}
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            stripped = line.strip()
            if not stripped:
                break
            if b":" in stripped:
                k, _, v = stripped.partition(b":")
                headers[k.decode().lower().strip()] = v.decode().strip()

        # Journal endpoint streams SSE on a long-lived connection; handle separately.
        if method == "GET" and path.split("?")[0] == "/journal":
            await _handle_journal_sse(path, writer)
            return

        body = await _read_body(reader, headers)
        status_code, response_body = await _route(method, path, body)
        payload = json.dumps(response_body).encode()

        status_text = {200: "OK", 400: "Bad Request", 404: "Not Found", 500: "Internal Server Error"}.get(
            status_code, "Unknown"
        )
        writer.write(
            f"HTTP/1.1 {status_code} {status_text}\r\n"
            f"Content-Type: application/json\r\n"
            f"Content-Length: {len(payload)}\r\n"
            f"Connection: close\r\n"
            f"\r\n".encode()
            + payload
        )
        await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def main() -> None:
    logger.info("Nimbus LXC agent daemon v%s starting on port %d", DAEMON_VERSION, HTTP_PORT)

    server = await asyncio.start_server(_handle_http, "0.0.0.0", HTTP_PORT)
    asyncio.create_task(_app_health_loop())
    asyncio.create_task(_dns_health_loop())

    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
