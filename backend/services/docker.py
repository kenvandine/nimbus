from __future__ import annotations
import asyncio
from dataclasses import dataclass
import hashlib
import logging
import re
import secrets
import shutil
from pathlib import Path
from typing import Optional

import yaml

from config import settings
from services.store import get_app_compose_path, get_app_meta
from services.network import get_host_ip

INSTALLED_DIR = settings.installed_dir

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class VolumePathSpec:
    path: str
    is_file: bool
    uid: int
    gid: int
    mode: int


@dataclass(frozen=True)
class PreparedAppBundle:
    app_id: str
    app_dir: Path
    data_dir: Path
    published_port: Optional[int]
    compose_text: str
    compose_data: dict
    env_text: str
    env_vars: dict[str, str]
    version: Optional[str]
    volume_paths: list[VolumePathSpec]


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


def _parse_env_text(env_text: str) -> dict[str, str]:
    return dict(line.split("=", 1) for line in env_text.splitlines() if "=" in line)


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


def _prepare_compose_data(
    app_id: str,
    compose_src: Path,
    *,
    overlay_dir: Optional[Path] = None,
    host_gateway_ip: Optional[str] = None,
) -> dict:
    """Return compose data patched for standalone (non-Umbrel) use.

    overlay_dir is the directory whose contents will be visible to the docker
    daemon at runtime. In local-docker mode that's the host snap's
    openclaw-overlay/ folder; in LXD mode the LXD manager pushes the same
    contents into a known path inside the container and passes that path here.

    host_gateway_ip overrides the special "host-gateway" magic alias for
    extra_hosts. Required in LXD mode because docker's host-gateway resolves
    to the LXC container, not the physical host where Lemonade lives.
    """
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

    # Replace Umbrel-branded values (usernames, domain names) with Nimbus equivalents.
    _rewrite_umbrel_values(services)

    # App-specific overlays (e.g. branding + Lemonade preselection for openclaw).
    if app_id == "openclaw":
        from services.model_provider import gateway_environment
        resolved_overlay = overlay_dir or (settings.overlay_dir / "openclaw-overlay")
        _apply_openclaw_overlay(
            services,
            resolved_overlay,
            host_gateway_ip,
            gateway_environment(),
        )

    data["services"] = services
    # Drop obsolete version key to silence docker compose warnings.
    data.pop("version", None)
    return data


def _apply_openclaw_overlay(
    services: dict,
    overlay_dir: Path,
    host_gateway_ip: Optional[str] = None,
    extra_env: Optional[dict[str, str]] = None,
) -> None:
    """Inject Nimbus's setup-wrapper.cjs and host.docker.internal into the
    openclaw 'gateway' service.

    The wrapper rebrands setup.html, preselects the configured model provider
    in the onboarding wizard, and tunes openclaw.json after the wizard exits.
    The provider runs as a host snap; host.docker.internal lets the container
    reach it.

    overlay_dir is the path where the docker daemon can see the wrapper at
    bind-mount time. In LXD mode the caller has already pushed the wrapper
    into the container at this path. extra_env carries the provider-specific
    NIMBUS_OPENCLAW_* settings produced by model_provider.gateway_environment().
    """
    gateway = services.get("gateway")
    if not isinstance(gateway, dict):
        return

    wrapper_path = overlay_dir / "setup-wrapper.cjs"

    extra_hosts = list(gateway.get("extra_hosts") or [])
    target = host_gateway_ip or "host-gateway"
    host_alias = f"host.docker.internal:{target}"
    if not any(h.startswith("host.docker.internal:") for h in extra_hosts):
        extra_hosts.append(host_alias)
    gateway["extra_hosts"] = extra_hosts

    volumes = list(gateway.get("volumes") or [])
    mount = f"{wrapper_path}:/app/setup-wrapper.cjs:ro"
    if mount not in volumes:
        volumes.append(mount)
    gateway["volumes"] = volumes

    # Override CMD so node loads our wrapper, which then require()s the
    # upstream /app/setup-server.cjs.
    gateway["command"] = ["node", "/app/setup-wrapper.cjs"]

    if extra_env:
        existing = gateway.get("environment")
        if isinstance(existing, list):
            existing_dict = dict(e.split("=", 1) for e in existing if "=" in e)
            existing_dict.update(extra_env)
            gateway["environment"] = [f"{k}={v}" for k, v in existing_dict.items()]
        else:
            env_dict = dict(existing) if isinstance(existing, dict) else {}
            env_dict.update(extra_env)
            gateway["environment"] = env_dict


def _prepare_compose(app_id: str, compose_src: Path, app_dir: Path) -> Path:
    data = _prepare_compose_data(app_id, compose_src)
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


_VALUE_MAP = {
    "umbrel": "nimbus",
    "umbrel@umbrel.local": "nimbus@nimbus.local",
    "umbrel.local": "nimbus.local",
}


def _rewrite_umbrel_values(services: dict) -> None:
    """Replace Umbrel-branded values in env vars with Nimbus equivalents."""
    for svc_cfg in services.values():
        env = svc_cfg.get("environment")
        if not env:
            continue
        if isinstance(env, dict):
            for key, value in env.items():
                if isinstance(value, str) and value in _VALUE_MAP:
                    env[key] = _VALUE_MAP[value]
        elif isinstance(env, list):
            for i, item in enumerate(env):
                if "=" in item:
                    k, v = item.split("=", 1)
                    if v in _VALUE_MAP:
                        env[i] = f"{k}={_VALUE_MAP[v]}"


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


def _collect_volume_paths(compose_data: dict, env_vars: dict[str, str]) -> list[VolumePathSpec]:
    import re

    def expand(s: str) -> str:
        for k, v in env_vars.items():
            s = s.replace(f"${{{k}}}", v).replace(f"${k}", v)
        s = re.sub(r'\$\{[^}]+\}', '', s).replace('$', '')
        return s

    paths: list[VolumePathSpec] = []
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
            container_path = spec.split(":")[1].split(":")[0]
            is_file = bool(p.suffix) or bool(Path(container_path).suffix)
            paths.append(
                VolumePathSpec(
                    path=str(p),
                    is_file=is_file,
                    uid=uid,
                    gid=gid,
                    mode=0o666 if is_file else 0o777,
                )
            )
    return paths


def _create_volume_dirs(volume_paths: list[VolumePathSpec]) -> None:
    """Pre-create all host-side bind-mount paths with correct ownership."""
    import os

    for spec in volume_paths:
        p = Path(spec.path)
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            if spec.is_file:
                if not p.exists():
                    p.touch()
            else:
                p.mkdir(parents=True, exist_ok=True)
            p.chmod(spec.mode)
            if spec.uid >= 0:
                os.chown(p, spec.uid, spec.gid)
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
    bundle = build_app_bundle(app_id)
    write_bundle_to_disk(bundle)

    rc, stdout, stderr = await _run(
        "docker", "compose", "-p", app_id, "-f", str(bundle.app_dir / "docker-compose.yml"),
        "--env-file", str(bundle.app_dir / ".env"),
        "up", "-d", "--remove-orphans",
    )
    if rc != 0:
        raise RuntimeError(f"docker compose up failed for {app_id}: {stderr}")

    logger.info("Installed %s: %s", app_id, stdout.strip())


def get_installed_version(app_id: str) -> Optional[str]:
    f = _app_dir(app_id) / ".nimbus-version"
    return f.read_text().strip() if f.exists() else None


async def update_app(app_id: str) -> None:
    app_dir = _app_dir(app_id)
    env_file = app_dir / ".env"
    bundle = build_app_bundle(app_id, env_text=env_file.read_text())
    write_bundle_to_disk(bundle)

    base_cmd = ["docker", "compose", "-p", app_id, "-f", str(app_dir / "docker-compose.yml"), "--env-file", str(env_file)]
    rc, _, stderr = await _run(*base_cmd, "pull")
    if rc != 0:
        logger.warning("docker compose pull warning for %s: %s", app_id, stderr)

    rc, _, stderr = await _run(*base_cmd, "up", "-d", "--remove-orphans")
    if rc != 0:
        raise RuntimeError(f"docker compose up failed during update of {app_id}: {stderr}")

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


async def get_container_names(app_id: str) -> list[str]:
    rc, stdout, _ = await _run(
        "docker", "ps",
        "--filter", f"label=com.docker.compose.project={app_id}",
        "--format", "{{.Names}}",
    )
    if rc != 0 or not stdout.strip():
        return []
    return [n for n in stdout.strip().splitlines() if n]


async def stream_app_logs(app_id: str, tail: int = 200):
    """Async generator yielding decoded log lines from all containers of app_id."""
    names = await get_container_names(app_id)
    if not names:
        return

    queue: asyncio.Queue[str | None] = asyncio.Queue()
    procs: list[asyncio.subprocess.Process] = []

    async def _drain(proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None
        try:
            async for raw in proc.stdout:
                await queue.put(raw.decode(errors="replace").rstrip())
        finally:
            await queue.put(None)

    try:
        for name in names:
            proc = await asyncio.create_subprocess_exec(
                "docker", "logs", "--follow", f"--tail={tail}", "--timestamps", name,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            procs.append(proc)
            asyncio.create_task(_drain(proc))

        exhausted = 0
        while exhausted < len(procs):
            item = await queue.get()
            if item is None:
                exhausted += 1
            else:
                yield item
    finally:
        for proc in procs:
            try:
                proc.terminate()
            except Exception:
                pass


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


def build_app_bundle(
    app_id: str,
    *,
    installed_dir: Path = INSTALLED_DIR,
    env_text: str | None = None,
    overlay_dir: Optional[Path] = None,
    host_gateway_ip: Optional[str] = None,
) -> PreparedAppBundle:
    compose_src = get_app_compose_path(app_id)
    if compose_src is None:
        raise FileNotFoundError(f"No docker-compose.yml found for app: {app_id}")

    app_dir = installed_dir / app_id
    data_dir = app_dir / "data"
    if env_text is None:
        seed = secrets.token_hex(32)
        app_password = _derive_password(seed)
        env_text = (
            f"APP_DATA_DIR={data_dir}\n"
            f"APP_SEED={seed}\n"
            f"APP_PASSWORD={app_password}\n"
            f"UMBREL_ROOT=/var/lib/nimbus\n"
            f"DEVICE_DOMAIN_NAME=nimbus.local\n"
            f"DEVICE_HOSTNAME=nimbus.local\n"
        )

    env_vars = _parse_env_text(env_text)
    compose_data = _prepare_compose_data(
        app_id,
        compose_src,
        overlay_dir=overlay_dir,
        host_gateway_ip=host_gateway_ip,
    )
    volume_paths = _collect_volume_paths(compose_data, env_vars)
    meta = get_app_meta(app_id)

    return PreparedAppBundle(
        app_id=app_id,
        app_dir=app_dir,
        data_dir=data_dir,
        published_port=meta.port_hint if meta else None,
        compose_text=yaml.dump(compose_data, default_flow_style=False),
        compose_data=compose_data,
        env_text=env_text,
        env_vars=env_vars,
        version=meta.version if meta and meta.version else None,
        volume_paths=volume_paths,
    )


def write_bundle_to_disk(bundle: PreparedAppBundle) -> None:
    bundle.app_dir.mkdir(parents=True, exist_ok=True)
    bundle.data_dir.mkdir(parents=True, exist_ok=True)
    bundle.data_dir.chmod(0o777)
    (bundle.app_dir / ".env").write_text(bundle.env_text)
    (bundle.app_dir / "docker-compose.yml").write_text(bundle.compose_text)
    _create_volume_dirs(bundle.volume_paths)
    if bundle.version:
        (bundle.app_dir / ".nimbus-version").write_text(bundle.version)
