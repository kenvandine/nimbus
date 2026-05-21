"""nimbus reset — remove all installed apps and re-trigger initialization.

Removes every docker-compose app from the LXD container and clears the
preseed state so the nimbus daemon reinstalls them on its next startup.
The LXD container and its bootstrap (docker, python, agent) are preserved;
only app data is wiped.
"""
from __future__ import annotations

import os
import sys


def _die(msg: str) -> None:
    print(f"Error: {msg}", file=sys.stderr)
    sys.exit(1)


def _run(instance, cmd: list[str], *, acceptable: set[int] = frozenset({0})) -> tuple[int, str, str]:
    rc, stdout, stderr = instance.execute(cmd)
    if rc not in acceptable:
        print(f"  Warning: command {cmd[0]!r} exited {rc}: {(stderr or stdout).strip()[:200]}")
    return rc, stdout, stderr


def main() -> None:
    if os.geteuid() != 0:
        _die("this command must be run as root (try: sudo nimbus.reset)")

    print("WARNING: All installed app data will be permanently deleted.")
    print("The nimbus service will reinstall apps automatically after the reset.")
    print()
    try:
        answer = input("Type 'yes' to confirm: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print("\nReset cancelled.")
        sys.exit(0)

    if answer != "yes":
        print("Reset cancelled.")
        sys.exit(0)

    print()

    try:
        from pylxd import Client
        from pylxd.exceptions import ClientConnectionFailed, NotFound
    except ImportError:
        _die("pylxd is not available — is the nimbus snap correctly installed?")

    container_name = os.getenv("NIMBUS_LXD_CONTAINER_NAME", "nimbus")
    lxd_dir = os.getenv("LXD_DIR", "/var/snap/lxd/common/lxd")
    os.environ.setdefault("LXD_DIR", lxd_dir)

    try:
        client = Client()
    except ClientConnectionFailed as exc:
        _die(f"Could not connect to LXD: {exc}")

    try:
        instance = client.instances.get(container_name)
    except NotFound:
        _die(f"LXD container '{container_name}' not found — has nimbus been bootstrapped?")

    if getattr(instance, "status", "").lower() != "running":
        _die(f"LXD container '{container_name}' is not running (status: {instance.status})")

    installed_dir = "/var/lib/nimbus/installed"
    preseed_state_lxc = "/var/lib/nimbus/.preseed_apps_state"

    # Discover installed apps from the container filesystem.
    _, stdout, _ = _run(instance, ["sh", "-c", f"ls '{installed_dir}' 2>/dev/null || true"],
                        acceptable={0, 1, 2})
    app_ids = [a.strip() for a in stdout.splitlines() if a.strip()]

    if app_ids:
        print(f"Stopping and removing {len(app_ids)} app(s): {', '.join(app_ids)}")
        for app_id in app_ids:
            compose_file = f"{installed_dir}/{app_id}/docker-compose.yml"
            env_file = f"{installed_dir}/{app_id}/.env"
            print(f"  {app_id}: docker compose down...")
            _run(instance, [
                "docker", "compose", "-p", app_id,
                "-f", compose_file, "--env-file", env_file,
                "down", "--volumes", "--remove-orphans",
            ], acceptable={0, 1})
    else:
        print("No installed apps found in container.")

    print("Clearing installed app directories...")
    _run(instance, ["sh", "-c", f"rm -rf '{installed_dir}'/*"], acceptable={0, 1})

    print("Clearing preseed state (container)...")
    _run(instance, ["rm", "-f", preseed_state_lxc], acceptable={0, 1})

    # Also clear the host-side preseed state written by LxdControlPlane.
    snap_common = os.getenv("SNAP_COMMON", "")
    if snap_common:
        host_preseed = os.path.join(snap_common, ".preseed_apps_state")
        try:
            os.unlink(host_preseed)
            print("Clearing preseed state (host)...")
        except FileNotFoundError:
            pass
        except OSError as exc:
            print(f"  Warning: could not remove host preseed state: {exc}")

    print("Restarting nimbus service...")
    rc = os.system("snapctl restart nimbus")
    if rc != 0:
        print("  Warning: snapctl restart returned non-zero; the daemon may need a manual restart.")

    print()
    print("Reset complete. Nimbus will reinstall your apps automatically.")


if __name__ == "__main__":
    main()
