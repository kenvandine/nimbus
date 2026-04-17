from __future__ import annotations
import asyncio
import logging

logger = logging.getLogger(__name__)

_cached_ip: str | None = None


async def get_host_ip() -> str:
    global _cached_ip
    if _cached_ip:
        return _cached_ip

    # Prefer eth0 — that's the LXD bridge interface reachable from the host.
    # hostname -I may return the Docker bridge (172.17.x.x) first, which is
    # only routable inside the container.
    try:
        proc = await asyncio.create_subprocess_exec(
            "ip", "-4", "addr", "show", "eth0",
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
        logger.warning("ip addr show eth0 failed: %s", exc)

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
