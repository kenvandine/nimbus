from __future__ import annotations

import logging
import re
from typing import Optional

logger = logging.getLogger(__name__)


def _lxd():
    from services.lxd import get_lxd_manager
    return get_lxd_manager()


def _run(cmd: list[str]) -> tuple[int, str, str]:
    """Run a command inside the managed LXC container, return (exit_code, stdout, stderr)."""
    mgr = _lxd()
    return mgr.exec_in_container(cmd)


def get_rules() -> list[dict]:
    """Return UFW rules as a list of dicts parsed from `ufw status numbered`."""
    code, out, _ = _run(["ufw", "status", "numbered"])
    if code != 0:
        return []
    rules = []
    for line in out.splitlines():
        m = re.match(r"\[\s*(\d+)\]\s+(.+?)\s{2,}(.+?)\s{2,}(.+)", line)
        if m:
            rules.append({
                "number": int(m.group(1)),
                "to": m.group(2).strip(),
                "action": m.group(3).strip(),
                "from": m.group(4).strip(),
            })
    return rules


def add_rule(port: int, proto: str, action: str) -> None:
    proto = proto.lower() if proto.lower() in ("tcp", "udp") else "tcp"
    action = action.lower() if action.lower() in ("allow", "deny", "reject") else "allow"
    code, _, err = _run(["ufw", action, f"{port}/{proto}"])
    if code != 0:
        raise RuntimeError(f"ufw add rule failed: {err}")


def delete_rule(number: int) -> None:
    code, _, err = _run(["bash", "-c", f"echo y | ufw delete {number}"])
    if code != 0:
        raise RuntimeError(f"ufw delete rule failed: {err}")


def get_status() -> dict:
    code, out, _ = _run(["ufw", "status"])
    enabled = "Status: active" in out if code == 0 else False
    return {"enabled": enabled}


def set_enabled(enabled: bool) -> None:
    if enabled:
        code, _, err = _run(["bash", "-c", "echo y | ufw enable"])
    else:
        code, _, err = _run(["bash", "-c", "echo y | ufw disable"])
    if code != 0:
        raise RuntimeError(f"ufw set enabled failed: {err}")
