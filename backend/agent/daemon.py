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

DAEMON_VERSION = "3"
INSTALLED_DIR = Path("/var/lib/nimbus/installed")
DOCKER_DAEMON_JSON = Path("/etc/docker/daemon.json")
DNS_SERVERS = ["1.1.1.1", "8.8.8.8"]
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
    proc = await asyncio.create_subprocess_exec(
        "getent", "hosts", DNS_CHECK_HOST,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.communicate()
    return proc.returncode == 0


async def _fix_system_dns() -> bool:
    """Override /etc/resolv.conf with direct public DNS, bypassing the broken
    lxdbr0/systemd-resolved stub that intermittently breaks Docker image pulls."""
    resolv_conf = Path("/etc/resolv.conf")
    content = "".join(f"nameserver {s}\n" for s in DNS_SERVERS)
    try:
        if resolv_conf.is_symlink():
            resolv_conf.unlink()
        elif resolv_conf.exists() and resolv_conf.read_text() == content:
            return False
        resolv_conf.write_text(content)
        logger.info("Wrote /etc/resolv.conf with public DNS servers")
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
    while True:
        try:
            ok = await _dns_resolves()
            if not ok:
                logger.warning("DNS resolution for %s failed — fixing system and Docker DNS", DNS_CHECK_HOST)
                await _fix_system_dns()
                await _ensure_docker_dns()
                await asyncio.sleep(3)  # let Docker and resolved settle
                ok = await _dns_resolves()
                if not ok:
                    logger.error("DNS still failing after fix attempt")
            _state["dns_ok"] = ok
        except Exception:
            logger.exception("Unhandled error in DNS health loop")
        await asyncio.sleep(DNS_CHECK_INTERVAL)


# ── Snap management (future) ───────────────────────────────────────────────────

async def _snap_install(name: str, channel: str = "stable") -> dict:
    proc = await asyncio.create_subprocess_exec(
        "snap", "install", name, "--channel", channel,
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
        result = await _snap_install(name, req.get("channel", "stable"))
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
