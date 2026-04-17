from __future__ import annotations
import asyncio
import hashlib
import logging
import re
import secrets
import shutil
from pathlib import Path
from typing import Optional

import yaml

from services.store import get_app_compose_path, get_app_meta
from services.network import get_host_ip

INSTALLED_DIR = Path("/var/lib/nimbus/installed")

logger = logging.getLogger(__name__)


async def _run(*args: str) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode, stdout.decode(), stderr.decode()


def _app_dir(app_id: str) -> Path:
    return INSTALLED_DIR / app_id


def _derive_password(seed: str) -> str:
    """Derive a deterministic password from the app seed (first 24 hex chars of sha256)."""
    return hashlib.sha256(seed.encode()).hexdigest()[:24]


def get_app_password(app_id: str) -> str:
    """Return the APP_PASSWORD for an installed app, or empty string if unavailable."""
    env_file = _app_dir(app_id) / ".env"
    if not env_file.exists():
        return ""
    for line in env_file.read_text().splitlines():
        if line.startswith("APP_PASSWORD="):
            return line.split("=", 1)[1]
    return ""


def installed_app_ids() -> list[str]:
    if not INSTALLED_DIR.exists():
        return []
    return [d.name for d in INSTALLED_DIR.iterdir() if d.is_dir()]


def _prepare_compose(app_id: str, compose_src: Path, app_dir: Path) -> Path:
    """Return a patched compose file suitable for standalone (non-Umbrel) use."""
    data = yaml.safe_load(compose_src.read_text())
    services = data.get("services", {})

    # Extract APP_PORT from app_proxy *before* removing it — this is the
    # container-internal port the web service actually listens on (may differ
    # from the external port declared in umbrel-app.yml).
    proxy_svc = services.get("app_proxy") or {}
    proxy_env = proxy_svc.get("environment") or {}
    if isinstance(proxy_env, list):
        proxy_env = dict(e.split("=", 1) for e in proxy_env if "=" in e)
    internal_port: Optional[int] = None
    if proxy_env.get("APP_PORT"):
        try:
            internal_port = int(proxy_env["APP_PORT"])
        except ValueError:
            pass

    # Remove app_proxy — it's an Umbrel-internal sidecar with no image.
    services.pop("app_proxy", None)

    # Drop depends_on references to app_proxy so remaining services start cleanly.
    for svc in services.values():
        deps = svc.get("depends_on")
        if isinstance(deps, list) and "app_proxy" in deps:
            deps.remove("app_proxy")
        elif isinstance(deps, dict):
            deps.pop("app_proxy", None)

    # Inject a host port mapping so the app is reachable directly.
    # Map external_port (from umbrel-app.yml) -> internal_port (from app_proxy APP_PORT).
    meta = get_app_meta(app_id)
    app_port = meta.port_hint if meta else None
    if app_port:
        container_port = internal_port or app_port
        web_svc = _find_web_service(services, container_port)
        if web_svc and web_svc in services:
            svc = services[web_svc]
            existing = [str(p) for p in (svc.get("ports") or [])]
            mapping = f"{app_port}:{container_port}"
            if not any(str(app_port) in p for p in existing):
                svc.setdefault("ports", []).append(mapping)

    # Rewrite old Compose v1 container hostname refs (immich_postgres_1) to
    # the plain service name (postgres), which is what Compose v2 DNS resolves.
    _fix_container_hostnames(app_id, services)

    data["services"] = services
    # Drop obsolete version key to silence docker compose warnings.
    data.pop("version", None)
    dest = app_dir / "docker-compose.yml"
    dest.write_text(yaml.dump(data, default_flow_style=False))
    return dest


def _fix_container_hostnames(app_id: str, services: dict) -> None:
    """Rewrite env values that reference old-style container names to service names.

    Umbrel sets e.g. DB_HOSTNAME=immich_postgres_1 expecting Compose v1 naming.
    Compose v2 only registers the service name (postgres) in the project DNS.
    """
    for svc_cfg in services.values():
        env = svc_cfg.get("environment")
        if not env:
            continue
        items = env.items() if isinstance(env, dict) else (e.split("=", 1) for e in env if "=" in e)
        for key, value in list(items):
            if not isinstance(value, str):
                continue
            new_value = value
            for svc_name in services:
                # Pattern: <app_id>_<service>_<n>  e.g. immich_postgres_1
                old_ref = f"{app_id}_{svc_name}_1"
                if old_ref in new_value:
                    new_value = new_value.replace(old_ref, svc_name)
            if new_value != value:
                if isinstance(env, dict):
                    env[key] = new_value


def _parse_user(user_spec: str) -> tuple[int, int]:
    """Parse a compose 'user:' value like '1000', '1000:1000', or 'root' into (uid, gid)."""
    if not user_spec:
        return (-1, -1)
    parts = str(user_spec).split(":")
    try:
        uid = int(parts[0])
        gid = int(parts[1]) if len(parts) > 1 else uid
        return (uid, gid)
    except ValueError:
        return (-1, -1)


def _create_volume_dirs(compose_data: dict, env_vars: dict) -> None:
    """Pre-create all host-side bind-mount directories with correct ownership.

    Docker creates missing host dirs as root, breaking containers that run as
    non-root users. We create them first and chown to the service's user.
    """
    import re

    def expand(s: str) -> str:
        for k, v in env_vars.items():
            s = s.replace(f"${{{k}}}", v).replace(f"${k}", v)
        s = re.sub(r'\$\{[^}]+\}', '', s).replace('$', '')
        return s

    for svc in compose_data.get("services", {}).values():
        uid, gid = _parse_user(svc.get("user", ""))
        for vol in svc.get("volumes") or []:
            spec = vol if isinstance(vol, str) else vol.get("source", "")
            if ":" not in spec:
                continue
            host_path = expand(spec.split(":")[0])
            if not host_path.startswith("/"):
                continue
            p = Path(host_path)
            try:
                # If the host path looks like a file (has an extension or the
                # container target is a file), create an empty file; otherwise a dir.
                container_path = spec.split(":")[1].split(":")[0]
                is_file = "." in p.name or "." in Path(container_path).name
                p.parent.mkdir(parents=True, exist_ok=True)
                if is_file:
                    if not p.exists():
                        p.touch()
                    p.chmod(0o666)
                else:
                    p.mkdir(parents=True, exist_ok=True)
                    p.chmod(0o777)
                if uid >= 0:
                    import os
                    os.chown(p, uid, gid)
            except Exception as exc:
                logger.debug("Could not pre-create volume path %s: %s", p, exc)


def _find_web_service(services: dict, port: int) -> Optional[str]:
    """Pick which service should receive the host port mapping."""
    # 1. Service that already exposes the target port
    for name, svc in services.items():
        exposed = svc.get("expose") or []
        if str(port) in [str(e) for e in exposed]:
            return name
    # 2. Service named 'app', 'server', or 'web'
    for preferred in ("app", "server", "web"):
        if preferred in services:
            return preferred
    # 3. First service that isn't a database
    db_keywords = {"db", "database", "postgres", "mysql", "redis", "mariadb", "mongo"}
    for name in services:
        if not any(kw in name.lower() for kw in db_keywords):
            return name
    return next(iter(services), None)


async def install_app(app_id: str) -> None:
    compose_src = get_app_compose_path(app_id)
    if compose_src is None:
        raise FileNotFoundError(f"No docker-compose.yml found for app: {app_id}")

    app_dir = _app_dir(app_id)
    data_dir = app_dir / "data"
    app_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    # Write env file satisfying Umbrel-specific variables apps expect.
    env_file = app_dir / ".env"
    if not env_file.exists():
        host_ip = await get_host_ip()
        seed = secrets.token_hex(32)
        app_password = _derive_password(seed)
        env_file.write_text(
            f"APP_DATA_DIR={data_dir}\n"
            f"APP_SEED={seed}\n"
            f"APP_PASSWORD={app_password}\n"
            f"UMBREL_ROOT=/var/lib/nimbus\n"
            f"DEVICE_DOMAIN_NAME={host_ip}\n"
            f"DEVICE_HOSTNAME={host_ip}\n"
        )

    # Ensure data dir is writable by any container user (apps vary: root, 1000, etc.)
    data_dir.mkdir(parents=True, exist_ok=True)
    data_dir.chmod(0o777)

    compose_file = _prepare_compose(app_id, compose_src, app_dir)

    # Pre-create bind-mount dirs so non-root container users can write to them.
    env_vars = dict(line.split("=", 1) for line in env_file.read_text().splitlines() if "=" in line)
    _create_volume_dirs(yaml.safe_load(compose_file.read_text()), env_vars)

    rc, stdout, stderr = await _run(
        "docker", "compose", "-p", app_id, "-f", str(compose_file),
        "--env-file", str(env_file),
        "up", "-d", "--remove-orphans",
    )
    if rc != 0:
        raise RuntimeError(f"docker compose up failed for {app_id}: {stderr}")

    # Record installed version so we can detect updates later.
    meta = get_app_meta(app_id)
    if meta and meta.version:
        (app_dir / ".nimbus-version").write_text(meta.version)

    logger.info("Installed %s: %s", app_id, stdout.strip())


def get_installed_version(app_id: str) -> Optional[str]:
    f = _app_dir(app_id) / ".nimbus-version"
    return f.read_text().strip() if f.exists() else None


async def update_app(app_id: str) -> None:
    compose_src = get_app_compose_path(app_id)
    if compose_src is None:
        raise FileNotFoundError(f"No compose file found for app: {app_id}")

    app_dir = _app_dir(app_id)
    env_file = app_dir / ".env"
    compose_file = _prepare_compose(app_id, compose_src, app_dir)
    env_vars = dict(line.split("=", 1) for line in env_file.read_text().splitlines() if "=" in line)
    _create_volume_dirs(yaml.safe_load(compose_file.read_text()), env_vars)

    base_cmd = ["docker", "compose", "-p", app_id, "-f", str(compose_file), "--env-file", str(env_file)]
    rc, _, stderr = await _run(*base_cmd, "pull")
    if rc != 0:
        logger.warning("docker compose pull warning for %s: %s", app_id, stderr)

    rc, _, stderr = await _run(*base_cmd, "up", "-d", "--remove-orphans")
    if rc != 0:
        raise RuntimeError(f"docker compose up failed during update of {app_id}: {stderr}")

    meta = get_app_meta(app_id)
    if meta and meta.version:
        (app_dir / ".nimbus-version").write_text(meta.version)

    logger.info("Updated %s", app_id)


async def uninstall_app(app_id: str) -> None:
    app_dir = _app_dir(app_id)
    compose_file = app_dir / "docker-compose.yml"
    env_file = app_dir / ".env"
    if compose_file.exists():
        cmd = ["docker", "compose", "-p", app_id, "-f", str(compose_file)]
        if env_file.exists():
            cmd += ["--env-file", str(env_file)]
        rc, _, stderr = await _run(*cmd, "down", "-v")
        if rc != 0:
            logger.warning("docker compose down error for %s: %s", app_id, stderr)
    if app_dir.exists():
        shutil.rmtree(app_dir)
    logger.info("Uninstalled %s", app_id)


async def is_running(app_id: str) -> bool:
    # Query docker directly using the compose project label — avoids docker compose
    # ps --filter quirks that differ across compose v2 versions.
    rc, stdout, _ = await _run(
        "docker", "ps",
        "--filter", f"label=com.docker.compose.project={app_id}",
        "--quiet",
    )
    return rc == 0 and bool(stdout.strip())


async def get_web_port(app_id: str) -> Optional[int]:
    # Get published ports for all containers in the project.
    # "docker ps --format {{.Ports}}" returns strings like "0.0.0.0:8080->80/tcp"
    rc, stdout, _ = await _run(
        "docker", "ps",
        "--filter", f"label=com.docker.compose.project={app_id}",
        "--format", "{{.Ports}}",
    )
    if rc != 0 or not stdout.strip():
        return None

    for line in stdout.strip().splitlines():
        # Prefer TCP ports; fall back to any published port
        tcp_ports = re.findall(r'(?:0\.0\.0\.0|\[::\]):(\d+)->\d+/tcp', line)
        if tcp_ports:
            return min(int(p) for p in tcp_ports)
        udp_ports = re.findall(r'(?:0\.0\.0\.0|\[::\]):(\d+)->\d+/udp', line)
        if udp_ports:
            return min(int(p) for p in udp_ports)
    return None
