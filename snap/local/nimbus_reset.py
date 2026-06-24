"""nimbus reset — delete the LXD container and re-trigger full bootstrap.

Stops and deletes the entire LXD container (including all app data) and
clears host-side state so the nimbus daemon recreates it from scratch on
the next startup.  The seeded LXD image is preserved so bootstrap does not
need to re-download the base image.
"""
from __future__ import annotations

import os
import subprocess
import sys


def _die(msg: str) -> None:
    print(f"Error: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    if os.geteuid() != 0:
        _die("this command must be run as root (try: sudo nimbus.reset)")

    print("WARNING: The nimbus container and ALL app data will be permanently deleted.")
    print("The nimbus service will recreate the container automatically after the reset.")
    print("This takes several minutes.")
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

    # Stop the host daemon first so it doesn't fight with deletion.
    snap_instance = os.getenv("SNAP_INSTANCE_NAME", "nimbus")
    svc = f"{snap_instance}.nimbus"
    print("Stopping nimbus daemon...")
    subprocess.run(["snapctl", "stop", svc], capture_output=True)

    try:
        client = Client()
    except ClientConnectionFailed as exc:
        _die(f"Could not connect to LXD: {exc}")

    try:
        instance = client.instances.get(container_name)
        status = getattr(instance, "status", "").lower()
        if status == "running":
            print(f"Stopping container '{container_name}'...")
            instance.stop(wait=True)
        print(f"Deleting container '{container_name}'...")
        instance.delete(wait=True)
        print(f"Container '{container_name}' deleted.")
    except NotFound:
        print(f"Container '{container_name}' not found — nothing to delete.")

    # Clear host-side preseed state so preseed runs again after bootstrap.
    snap_common = os.getenv("SNAP_COMMON", "")
    if snap_common:
        for name in (".preseed_apps_state",):
            path = os.path.join(snap_common, name)
            try:
                os.unlink(path)
                print(f"Cleared {path}")
            except FileNotFoundError:
                pass
            except OSError as exc:
                print(f"  Warning: could not remove {path}: {exc}")

    print("Restarting nimbus daemon (full bootstrap will begin)...")
    result = subprocess.run(["snapctl", "start", svc], capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  Warning: snapctl start {svc!r} failed: {result.stderr.strip()}")
        print(f"  Start manually: sudo snap start nimbus")

    print()
    print("Reset complete. Bootstrap will take several minutes — watch progress in the UI.")


if __name__ == "__main__":
    main()
