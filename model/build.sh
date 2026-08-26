#!/bin/sh

set -eu

usage() {
    cat >&2 <<EOF
usage: $0 nimbus-lemonade|nimbus-gemma4 [--preseed|--no-preseed]

Defaults:
  nimbus-amd       preseed ON  (lemonade install hook is preseed-safe)
  nimbus-lemonade  preseed ON  (lemonade install hook is preseed-safe)
  nimbus-gemma4    preseed OFF (gemma4 install hook fails during preseed
                                — runs a hardware/RAM check in a cgroup-
                                constrained snap-preseed sandbox)
EOF
    exit 1
}

[ -n "${TMPDIR:-}" ] || TMPDIR=/tmp

inject_nm_lxd_unmanaged() {
    img=$1
    seed_img=$2
    systems_root=$3
    # Optional: pass "lemonade" to also seed the lemonade-configure systemd service
    extra=${4:-}
    system_name=
    preseed_tgz=
    preseed_assert=
    workdir=
    rebuilt_preseed=
    rebuilt_assert_json=
    rebuilt_assert=
    nm_relpath=var/snap/network-manager/common/etc/NetworkManager/conf.d/90-lxd-unmanaged.conf
    seed_start=
    artifact_sha=

    command -v mcopy >/dev/null 2>&1 || {
        echo "mtools is required (missing mcopy)" >&2
        return 1
    }

    if [ ! -f "$seed_img" ]; then
        echo "missing seed partition image: $seed_img" >&2
        return 1
    fi

    system_name=$(find "$systems_root" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | head -n 1 || true)
    if [ -z "$system_name" ]; then
        echo "could not locate system seed root in $systems_root" >&2
        return 1
    fi

    preseed_tgz="$systems_root/$system_name/preseed.tgz"
    preseed_assert="$systems_root/$system_name/preseed"
    if [ ! -f "$preseed_tgz" ]; then
        echo "could not locate preseed archive: $preseed_tgz" >&2
        return 1
    fi
    if [ ! -f "$preseed_assert" ]; then
        echo "could not locate preseed assertion: $preseed_assert" >&2
        return 1
    fi

    workdir=$(mktemp -d "${TMPDIR%/}/nimbus-preseed.XXXXXX")
    if ! tar -xzf "$preseed_tgz" -C "$workdir"; then
        rm -rf "$workdir"
        return 1
    fi

    mkdir -p "$workdir/$(dirname "$nm_relpath")"
    cat > "$workdir/$nm_relpath" <<'EOF'
[keyfile]
unmanaged-devices=interface-name:lxdbr0;interface-name:veth*
EOF

    nm_dnsmasq_relpath=var/snap/network-manager/common/etc/NetworkManager/dnsmasq-shared.d/nimbus-captive-portal.conf
    mkdir -p "$workdir/$(dirname "$nm_dnsmasq_relpath")"
    cat > "$workdir/$nm_dnsmasq_relpath" <<'EOF'
# Redirect all DNS queries to the gateway IP for the captive portal flow
address=/#/10.42.0.1
EOF


    # ── System performance fixes (applied to all models) ──────────────────────

    # 1. Mask ttyS0 getty — no serial console hardware; agetty respawns every
    #    10s generating noise and unnecessary load.
    mkdir -p "$workdir/etc/systemd/system"
    ln -sf /dev/null "$workdir/etc/systemd/system/serial-getty@ttyS0.service"

    # 2. Blacklist NXP NCI I2C (NFC) driver — generates a continuous IRQ storm
    #    on AMD hardware consuming 50-60% of a CPU core.
    #    The kernel cmdline blacklist in gadget.yaml handles the kernel/initramfs
    #    phase; this file covers userspace modprobe attempts.
    mkdir -p "$workdir/etc/modprobe.d"
    printf 'blacklist nxp_nci_i2c\n' > "$workdir/etc/modprobe.d/nfc.conf"

    # 3. Set CPU scaling governor to performance on every boot.
    #    Default powersave runs cores at ~33% of max frequency on this hardware.
    mkdir -p "$workdir/etc/systemd/system/multi-user.target.wants"
    cat > "$workdir/etc/systemd/system/cpu-performance.service" <<'UNIT'
[Unit]
Description=Set CPU scaling governor to performance
DefaultDependencies=no
After=sysinit.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'echo performance | tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
    ln -sf /etc/systemd/system/cpu-performance.service \
        "$workdir/etc/systemd/system/multi-user.target.wants/cpu-performance.service"
    echo "    Applied system performance fixes (getty mask, NFC blacklist, CPU governor)"

    # 4. Clear chromium's stale SingletonLock before the kiosk browser starts.
    #    An unclean shutdown leaves the lock behind, which makes chromium
    #    refuse to start on the next boot until someone deletes it by hand.
    #    This used to be installed by the gadget's configure hook, but a
    #    strictly-confined gadget hook can't write to /etc/systemd/system or
    #    call systemctl, so the gadget failed to install. snapcraft's own
    #    app-level before/after keys only order services within the same
    #    snap, so this hand-written unit references the other snaps'
    #    generated service names directly; it and they are all
    #    WantedBy=multi-user.target, which puts them in the same boot
    #    transaction for the ordering to take effect.
    cat > "$workdir/etc/systemd/system/nimbus-chromium-lock-fixup.service" <<'UNIT'
[Unit]
Description=Remove stale chromium SingletonLock before the kiosk browser starts
DefaultDependencies=no
Before=snap.chromium.daemon.service snap.ubuntu-frame.daemon.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'rm -f /root/snap/chromium/common/chromium/SingletonLock'

[Install]
WantedBy=multi-user.target
UNIT
    ln -sf /etc/systemd/system/nimbus-chromium-lock-fixup.service \
        "$workdir/etc/systemd/system/multi-user.target.wants/nimbus-chromium-lock-fixup.service"
    echo "    Added nimbus-chromium-lock-fixup.service to preseed"

    # 5. Hardware power key: run a configurable action when KEY_F23 is held.
    #    The kiosk has no software path to shut down, so the F23 button on the
    #    chassis acts as the power key: hold it for 20 seconds without
    #    releasing and the system runs the configured action, which defaults
    #    to "systemctl poweroff -i". Releasing the key before the threshold
    #    cancels.
    #    The watcher script sits at the system-data root, so it is reachable
    #    at /writable/system-data/nimbus-key-poweroff.py on the running device;
    #    the action and hold time are overridden in /etc/nimbus-key-poweroff.conf.
    cat > "$workdir/etc/nimbus-key-poweroff.conf" <<'CONF'
# Configuration for nimbus-key-poweroff.service.
#
# Command to run when KEY_F23 is held down without being released.
KEYPOWEROFF_ACTION="systemctl poweroff -i"
# Seconds the key must be held down before the action runs.
KEYPOWEROFF_HOLD_SECONDS=20
# Warning bell: sound played every BELL_INTERVAL seconds while the key is
# held (5s/10s/15s/20s before the action runs). A name plays a sound bundled
# in the nimbus snap (bell, warty-startup); a path is played locally.
KEYPOWEROFF_BELL="bell"
KEYPOWEROFF_BELL_INTERVAL=5
# evdev key code(s) to watch, comma-separated (default "193").
#   193 = KEY_F23 (chassis reset button; it also emits LEFTMETA 125 + LEFTSHIFT 42)
# Confirm what the button on the target device emits with
# `sudo python3 nimbus-key-poweroff-debug.py --all` (look for "key N press").
KEYPOWEROFF_KEY="193"
# Optional: watch only this single input event device.
# By default all of /dev/input/event* is watched.
#KEYPOWEROFF_DEVICE=/dev/input/event4
CONF
    cat > "$workdir/nimbus-key-poweroff.py" <<'PY'
#!/usr/bin/python3
"""Watch for a held KEY_F23 and run a configurable action.

The Nimbus kiosk has no software path to shut down, so the F23 button on
the chassis acts as the hardware power key: hold it for 20 seconds
without releasing and the system runs the configured action, which
defaults to "systemctl poweroff -i". Releasing the key before the hold
threshold cancels the pending action. While the key is held, a warning
bell sounds every 5 seconds (at 5s, 10s, 15s, 20s).

All /dev/input/event* devices are watched: hot-plugged devices are picked
up, removed ones are dropped. Every press, release, and action is logged
to the systemd journal.

Environment (from /etc/nimbus-key-poweroff.conf):
  KEYPOWEROFF_ACTION        command to run once the hold threshold is met
                            (default: "systemctl poweroff -i")
  KEYPOWEROFF_HOLD_SECONDS  seconds the key must be held down
                            (default: 20)
  KEYPOWEROFF_BELL          sound played while the key is held: a bundled
                            sound name (default: "bell") or a file path
  KEYPOWEROFF_BELL_INTERVAL seconds between held-key warning bells
                            (default: 5)
  KEYPOWEROFF_DEVICE        optional: watch only this single event device
                            (default: all of /dev/input/event*)
  KEYPOWEROFF_KEY           evdev key code(s) to watch, comma- or
                            space-separated (default: "193" - KEY_F23, which the
                            chassis reset button emits)
"""

import glob
import os
import pwd
import select
import struct
import subprocess
import sys
import time

KEY_F23 = 193         # KEY_F23 (input-event-codes.h); reset button emits it with LEFTMETA (125) + LEFTSHIFT (42)
EV_KEY = 0x01
# struct input_event (64-bit): 2x int64 timeval, u16 type, u16 code, s32 value
INPUT_EVENT = struct.Struct(("<" if sys.byteorder == "little" else ">") + "qqHHl")

DEFAULT_ACTION = "systemctl poweroff -i"
DEFAULT_HOLD_SECONDS = 20.0
DEFAULT_BELL = "bell"
DEFAULT_BELL_INTERVAL = 5.0
DEFAULT_DEVICE_GLOB = "/dev/input/event*"
YARU_STEREO = "/usr/share/sounds/Yaru/stereo"
NIMBUS_SNAP_SOUNDS = "/snap/nimbus/current/share/sounds/nimbus"
DEFAULT_KEY_CODES = {KEY_F23}
READ_CHUNK = 4096


def log(msg):
    print("nimbus-key-poweroff: %s" % msg, flush=True)


def parse_key_codes(raw, default):
    raw = (raw or "").strip()
    if not raw:
        return set(default)
    codes = set()
    for tok in raw.replace(",", " ").split():
        try:
            codes.add(int(tok))
        except ValueError:
            log("warning: ignoring invalid key code %r" % tok)
    return codes or set(default)


def session_user():
    """Return the local user running an audio server (dev machines).

    Prefers a user with a PipeWire or PulseAudio socket in their runtime
    directory; falls back to the first non-root runtime directory.
    """
    try:
        uids = sorted((u for u in os.listdir("/run/user") if u.isdigit()),
                      key=int)
    except OSError:
        return None
    fallback = None
    for uid in uids:
        if int(uid) == 0:
            continue
        try:
            pw = pwd.getpwuid(int(uid))
        except KeyError:
            continue
        rt = "/run/user/%s" % uid
        if os.path.exists(os.path.join(rt, "pipewire-0")) or \
           os.path.exists(os.path.join(rt, "pulse", "native")):
            return pw.pw_name
        if fallback is None:
            fallback = pw.pw_name
    return fallback


def _local_paplay(path, say):
    """Play via the local session's audio server, else plain paplay."""
    user = session_user()
    if user is not None:
        try:
            pw = pwd.getpwnam(user)
            cmd = ["setpriv", "--reuid", str(pw.pw_uid), "--regid", str(pw.pw_gid),
                   "--clear-groups", "env",
                   "XDG_RUNTIME_DIR=/run/user/%d" % pw.pw_uid,
                   "paplay", path]
            rc = subprocess.call(cmd, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, timeout=10)
            if rc == 0:
                return
            say("bell: session paplay failed (exit %d), retrying locally" % rc)
        except (OSError, subprocess.TimeoutExpired) as exc:
            say("bell: session paplay failed (%s), retrying locally" % exc)
    try:
        subprocess.call(["paplay", path], stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as exc:
        say("bell: %s" % exc)


def play_sound(spec, say):
    """Play a sound: a bundled name (bell, warty-startup) or a file path.

    Inside the snap, the staged paplay and staged sound are used. On a host
    without a login session (Ubuntu Core), the nimbus snap's paplay app is
    used. On a dev machine, the local session's audio server is used.
    """
    if os.environ.get("SNAP"):
        if spec.startswith("/"):
            path = spec
        else:
            path = os.path.join(os.environ["SNAP"], "share", "sounds",
                                "nimbus", spec + ".oga")
        if not os.path.exists(path):
            say("bell: sound %s not found" % path)
            return
        paplay = os.path.join(os.environ["SNAP"], "usr", "bin", "paplay")
        if not os.path.exists(paplay):
            paplay = "paplay"
        try:
            subprocess.call([paplay, path], stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=10)
        except (OSError, subprocess.TimeoutExpired) as exc:
            say("bell: %s" % exc)
        return
    if "/" not in spec:
        if os.path.exists(os.path.join(NIMBUS_SNAP_SOUNDS, spec + ".oga")):
            try:
                subprocess.call(["snap", "run", "nimbus.paplay", spec],
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=15)
            except (OSError, subprocess.TimeoutExpired) as exc:
                say("bell: snap run nimbus.paplay %s failed: %s" % (spec, exc))
            return
        path = os.path.join(YARU_STEREO, spec + ".oga")
    else:
        path = spec
    if not os.path.exists(path):
        say("bell: sound %s not found" % path)
        return
    _local_paplay(path, say)


def config():
    action = os.environ.get("KEYPOWEROFF_ACTION", DEFAULT_ACTION).strip()
    if not action:
        action = DEFAULT_ACTION
    try:
        hold = float(os.environ.get("KEYPOWEROFF_HOLD_SECONDS", DEFAULT_HOLD_SECONDS))
    except ValueError:
        log("warning: invalid KEYPOWEROFF_HOLD_SECONDS, using %.0f" % DEFAULT_HOLD_SECONDS)
        hold = DEFAULT_HOLD_SECONDS
    hold = max(hold, 0.1)
    device = os.environ.get("KEYPOWEROFF_DEVICE", "").strip()
    if not device:
        device = DEFAULT_DEVICE_GLOB
    key_codes = parse_key_codes(os.environ.get("KEYPOWEROFF_KEY"), DEFAULT_KEY_CODES)
    bell = os.environ.get("KEYPOWEROFF_BELL", DEFAULT_BELL).strip()
    if not bell:
        bell = DEFAULT_BELL
    try:
        bell_interval = float(os.environ.get("KEYPOWEROFF_BELL_INTERVAL",
                                             DEFAULT_BELL_INTERVAL))
    except ValueError:
        log("warning: invalid KEYPOWEROFF_BELL_INTERVAL, using %.0f"
            % DEFAULT_BELL_INTERVAL)
        bell_interval = DEFAULT_BELL_INTERVAL
    bell_interval = max(bell_interval, 0.5)
    return action, hold, device, key_codes, bell, bell_interval


def main():
    action, hold, device_glob, key_codes, bell, bell_interval = config()
    log("started: key(s) %s held for %.0fs runs %r; bell %r every %.0fs while held"
        % (",".join(str(c) for c in sorted(key_codes)), hold, action, bell,
           bell_interval))

    devices = {}        # path -> fd
    pressed_at = None   # monotonic time of the current KEY_F23 press
    pressed_path = None # device that reported the current press
    next_bell_at = None # monotonic time of the next held-key bell
    fired = False       # action already ran for the current press

    def release(why):
        nonlocal pressed_at, pressed_path, next_bell_at, fired
        if pressed_at is None:
            return
        held = time.monotonic() - pressed_at
        if fired:
            log("KEY_F23 %s after %.1fs (action already ran)" % (why, held))
        else:
            log("KEY_F23 %s after %.1fs of %.0fs - action cancelled" % (why, held, hold))
        pressed_at = None
        pressed_path = None
        next_bell_at = None
        fired = False

    def drop(path, reason):
        fd = devices.pop(path, None)
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        log("no longer watching %s (%s)" % (path, reason))
        if pressed_path == path:
            release("device removed while held")

    def rescan():
        present = set(glob.glob(device_glob))
        for path in sorted(set(devices) - present):
            drop(path, "device removed")
        for path in sorted(present):
            if path in devices:
                continue
            try:
                devices[path] = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError as exc:
                log("warning: cannot open %s: %s" % (path, exc))
                continue
            log("watching %s" % path)

    while True:
        now = time.monotonic()
        if pressed_at is not None and not fired:
            if next_bell_at is None:
                next_bell_at = pressed_at + bell_interval
            elif now >= next_bell_at:
                play_sound(bell, log)
                next_bell_at += bell_interval
        if pressed_at is not None and not fired and now - pressed_at >= hold:
            fired = True
            log("KEY_F23 held for %.0fs - running: %s" % (hold, action))
            try:
                rc = subprocess.call(action, shell=True)
                log("action exited with code %d" % rc)
            except Exception as exc:
                log("error running action: %s" % exc)

        rescan()
        if not devices:
            log("no input devices present, retrying in 5s")
            time.sleep(5)
            continue

        readable, _, _ = select.select(list(devices.values()), [], [], 0.25)
        for path, fd in list(devices.items()):
            if fd not in readable:
                continue
            try:
                data = os.read(fd, READ_CHUNK)
            except (BlockingIOError, InterruptedError):
                continue
            except OSError as exc:
                drop(path, str(exc))
                continue
            for off in range(0, len(data) - INPUT_EVENT.size + 1, INPUT_EVENT.size):
                _, _, ev_type, code, value = INPUT_EVENT.unpack_from(data, off)
                if ev_type != EV_KEY or code not in key_codes:
                    continue
                if value == 0:
                    release("released")
                elif pressed_at is None:
                    # value 1 (press) or 2 (auto-repeat) on an untracked key
                    pressed_at = time.monotonic()
                    pressed_path = path
                    fired = False
                    log("KEY_F23 pressed on %s - will run %r if held for %.0fs"
                        % (path, action, hold))


if __name__ == "__main__":
    main()
PY
    cat > "$workdir/etc/systemd/system/nimbus-key-poweroff.service" <<'UNIT'
[Unit]
Description=Run configured action when KEY_F23 is held for 20s (default: power off)
After=multi-user.target
Wants=multi-user.target

[Service]
Type=simple
EnvironmentFile=-/etc/nimbus-key-poweroff.conf
ExecStart=/usr/bin/python3 /writable/system-data/nimbus-key-poweroff.py
Restart=always
RestartSec=5
SyslogIdentifier=nimbus-key-poweroff
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
    ln -sf /etc/systemd/system/nimbus-key-poweroff.service \
        "$workdir/etc/systemd/system/multi-user.target.wants/nimbus-key-poweroff.service"
    echo "    Added nimbus-key-poweroff.service to preseed"

    # ─────────────────────────────────────────────────────────────────────────

    # Connect nimbus system: slot interfaces that the gadget connections: section
    # cannot wire up without store auto-connect assertions.
    svc_dir="$workdir/etc/systemd/system"
    mkdir -p "$svc_dir/multi-user.target.wants"
    cat > "$svc_dir/nimbus-connect.service" <<'UNIT'
[Unit]
Description=Connect nimbus snap interfaces not handled by gadget connections
After=snapd.seeded.service
Wants=snapd.seeded.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c ' \
snap connect nimbus:firewall-control; \
snap connect nimbus:audio-playback; \
snap connect nimbus:network-control; \
snap connect nimbus:network-observe; \
snap connect nimbus:system-observe; \
snap connect nimbus:hardware-observe; \
/snap/bin/tailscale set --webclient || true; \
snap set system hostname=nimbus; \
hostnamectl set-hostname --transient nimbus || true; \
snap set system service.systemd-resolved.multicast-dns=yes; \
systemctl restart systemd-resolved || true; \
AVAHI_CONF=/var/snap/avahi/common/etc/avahi/avahi-daemon.conf; \
if [ -f "$AVAHI_CONF" ]; then \
  AVAHI_CHANGED=0; \
  if ! grep -q "^deny-interfaces=" "$AVAHI_CONF"; then \
    if grep -q "^#deny-interfaces=" "$AVAHI_CONF"; then \
      sed -i "s/^#deny-interfaces=.*/deny-interfaces=lxdbr0,docker0/" "$AVAHI_CONF"; \
    else \
      sed -i "/^\[server\]/a deny-interfaces=lxdbr0,docker0" "$AVAHI_CONF"; \
    fi; \
    AVAHI_CHANGED=1; \
  fi; \
  if ! grep -q "^host-name=nimbus" "$AVAHI_CONF"; then \
    if grep -q "^#host-name=" "$AVAHI_CONF"; then \
      sed -i "s/^#host-name=.*/host-name=nimbus/" "$AVAHI_CONF"; \
    else \
      sed -i "/^\[server\]/a host-name=nimbus" "$AVAHI_CONF"; \
    fi; \
    AVAHI_CHANGED=1; \
  fi; \
  [ "$AVAHI_CHANGED" = "1" ] && snap restart avahi || true; \
fi; \
NM_DROPIN=/var/snap/network-manager/current/conf.d/90-lxd-unmanaged.conf; \
NM_CONTENT="[keyfile]\nunmanaged-devices=interface-name:lxdbr*;interface-name:veth*\n"; \
NM_DNSMASQ_CONTENT="# Redirect all DNS queries to the gateway IP for the captive portal flow\naddress=/#/10.42.0.1\n"; \
NM_CHANGED=0; \
mkdir -p "$(dirname $NM_DROPIN)" || true; \
if [ ! -f "$NM_DROPIN" ] || [ "$(cat $NM_DROPIN)" != "$(printf "$NM_CONTENT")" ]; then \
  printf "$NM_CONTENT" > "$NM_DROPIN" && NM_CHANGED=1; \
fi; \
for NM_DNSMASQ in \
  /var/snap/network-manager/current/dnsmasq-shared.d/nimbus-captive-portal.conf \
  /var/snap/network-manager/current/conf/dnsmasq-shared.d/nimbus-captive-portal.conf \
  /var/snap/network-manager/current/etc/NetworkManager/dnsmasq-shared.d/nimbus-captive-portal.conf; do \
  mkdir -p "$(dirname $NM_DNSMASQ)" || true; \
  if [ ! -f "$NM_DNSMASQ" ] || [ "$(cat $NM_DNSMASQ)" != "$(printf "$NM_DNSMASQ_CONTENT")" ]; then \
    printf "$NM_DNSMASQ_CONTENT" > "$NM_DNSMASQ" && NM_CHANGED=1; \
  fi; \
done; \
[ "$NM_CHANGED" = "1" ] && snap restart network-manager || true; \
mkdir -p /var/snap/nimbus/common/sideload; \
if mount -o ro /dev/disk/by-partlabel/nimbus-sideload /var/snap/nimbus/common/sideload; then \
  if [ -d /var/snap/nimbus/common/sideload/huggingface/hub ]; then \
    mkdir -p /var/snap/lemonade-server/common/.cache/huggingface/hub; \
    mv /var/snap/nimbus/common/sideload/huggingface/hub/* /var/snap/lemonade-server/common/.cache/huggingface/hub/ 2>/dev/null || true; \
  fi; \
  if [ -f /var/snap/nimbus/common/sideload/model_override.json ]; then \
    mv /var/snap/nimbus/common/sideload/model_override.json /var/snap/nimbus/common/model_override.json 2>/dev/null || true; \
  fi; \
  if [ -f /var/snap/nimbus/common/sideload/lxc-seed/nimbus-lxc-seed.tar.gz ]; then \
    mkdir -p /var/snap/nimbus/common/lxc-seed; \
    mv /var/snap/nimbus/common/sideload/lxc-seed/nimbus-lxc-seed.tar.gz /var/snap/nimbus/common/lxc-seed/ 2>/dev/null || true; \
  fi; \
  umount /var/snap/nimbus/common/sideload || true; \
fi'
RemainAfterExit=yes
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
    ln -sf /etc/systemd/system/nimbus-connect.service \
        "$svc_dir/multi-user.target.wants/nimbus-connect.service"
    echo "    Added nimbus-connect.service to preseed"

    cat > "$svc_dir/nimbus-lxc-restart.service" <<'UNIT'
[Unit]
Description=Restart nimbus LXC container after snap interfaces are connected
After=nimbus-connect.service
Wants=nimbus-connect.service

[Service]
Type=oneshot
ExecStart=/snap/bin/lxc restart nimbus
RemainAfterExit=yes
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
    ln -sf /etc/systemd/system/nimbus-lxc-restart.service \
        "$svc_dir/multi-user.target.wants/nimbus-lxc-restart.service"
    echo "    Added nimbus-lxc-restart.service to preseed"

    cat > "$svc_dir/tailscale-web.service" <<'UNIT'
[Unit]
Description=Tailscale web management UI (local reverse-proxy target)
After=snap.tailscale.tailscaled.service
Wants=snap.tailscale.tailscaled.service

[Service]
Type=simple
ExecStart=/snap/bin/tailscale web --listen=127.0.0.1:8088
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
    ln -sf /etc/systemd/system/tailscale-web.service \
        "$svc_dir/multi-user.target.wants/tailscale-web.service"
    echo "    Added tailscale-web.service to preseed"

    # Auth bridge: reads the auth URL from the tailscale socket and exposes it
    # on localhost:8089/api/auth/session/new for the Nimbus proxy.  Runs as root
    # so it can access /var/snap/tailscale/common/socket/tailscaled.sock without
    # the system-files snap interface.
    # Stored at the system-data root so it is accessible at the absolute path
    # /writable/system-data/tailscale-auth-bridge.py on the running device.
    # (/var/lib is read-only squashfs on Ubuntu Core — not overlaid by system-data.)
    cat > "$workdir/tailscale-auth-bridge.py" <<'PY'
#!/usr/bin/python3
import http.client, json, socket, time
from http.server import BaseHTTPRequestHandler, HTTPServer

_SOCK = "/var/snap/tailscale/common/socket/tailscaled.sock"
_HOST = "local-tailscaled.sock"

class _UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(_SOCK)

def _localapi(method, path, body=None):
    c = _UnixHTTP(_HOST)
    headers = {"Host": _HOST}
    if body is not None:
        headers["Content-Length"] = str(len(body))
    c.request(method, path, body=body, headers=headers)
    r = c.getresponse()
    return r.status, r.read()

def get_auth_url(timeout=20):
    status, body = _localapi("GET", "/localapi/v0/status")
    if status == 200:
        d = json.loads(body)
        if d.get("AuthURL"):
            return d["AuthURL"]
        if d.get("BackendState") == "Running":
            return None
    _localapi("POST", "/localapi/v0/login-interactive", body=b"")
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(1)
        status, body = _localapi("GET", "/localapi/v0/status")
        if status == 200:
            d = json.loads(body)
            if d.get("AuthURL"):
                return d["AuthURL"]
            if d.get("BackendState") == "Running":
                return None
    return None

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _send_json(self, body_dict):
        body = json.dumps(body_dict).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/api/auth/session/new":
            self.send_error(404); return
        try:
            auth_url = get_auth_url()
        except Exception as e:
            self.send_error(502, str(e)); return
        if auth_url:
            self._send_json({"authUrl": auth_url})
        else:
            self.send_error(502, "no auth URL from tailscale")

    def do_POST(self):
        if self.path != "/api/up":
            self.send_error(404); return
        try:
            auth_url = get_auth_url()
        except Exception as e:
            self.send_error(502, str(e)); return
        if auth_url:
            # JS checks i.url (lowercase) — from tailscale web client source
            self._send_json({"url": auth_url})
        else:
            self.send_error(502, "no auth URL from tailscale")

HTTPServer(("127.0.0.1", 8089), Handler).serve_forever()
PY

    cat > "$svc_dir/tailscale-auth-bridge.service" <<'UNIT'
[Unit]
Description=Tailscale auth URL bridge (for Nimbus web proxy)
After=snap.tailscale.tailscaled.service
Wants=snap.tailscale.tailscaled.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 /writable/system-data/tailscale-auth-bridge.py
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
    ln -sf /etc/systemd/system/tailscale-auth-bridge.service \
        "$svc_dir/multi-user.target.wants/tailscale-auth-bridge.service"
    echo "    Added tailscale-auth-bridge.service to preseed"

    if [ "$extra" = "lemonade" ]; then
        cat > "$svc_dir/lemonade-configure.service" <<'UNIT'
[Unit]
Description=Configure lemonade-server to bind on all network interfaces
After=snap.lemonade-server.daemon.service
BindsTo=snap.lemonade-server.daemon.service

[Service]
Type=oneshot
ExecStart=/snap/bin/lemonade-server config set host=0.0.0.0
RemainAfterExit=yes
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
        ln -sf /etc/systemd/system/lemonade-configure.service \
            "$svc_dir/multi-user.target.wants/lemonade-configure.service"
        echo "    Added lemonade-configure.service to preseed"
    fi

    rebuilt_preseed=$(mktemp "${TMPDIR%/}/nimbus-preseed-tgz.XXXXXX")
    tar --numeric-owner --owner=0 --group=0 -C "$workdir" -czf "$rebuilt_preseed" .

    artifact_sha=$(
        python3 - "$rebuilt_preseed" <<'PY'
import base64, hashlib, sys
with open(sys.argv[1], 'rb') as f:
    digest = hashlib.sha3_384(f.read()).digest()
print(base64.urlsafe_b64encode(digest).decode().rstrip('='))
PY
    )

    rebuilt_assert_json=$(mktemp "${TMPDIR%/}/nimbus-preseed-assert.XXXXXX.json")
    python3 - "$preseed_assert" "$artifact_sha" > "$rebuilt_assert_json" <<'PY'
import json, sys
from pathlib import Path

path = Path(sys.argv[1])
artifact_sha = sys.argv[2]
header = path.read_text().split("\n\n", 1)[0].splitlines()

data = {}
snaps = []
current = None

for line in header:
    if not line.strip():
        continue
    if line.startswith("snaps:"):
        data["snaps"] = snaps
        continue
    if line.startswith("  -"):
        current = {}
        snaps.append(current)
        continue
    if line.startswith("    "):
        key, value = line.strip().split(":", 1)
        if current is None:
            raise SystemExit(f"unexpected nested line: {line}")
        current[key] = value.strip()
        continue
    key, value = line.split(":", 1)
    key = key.strip()
    if key in {"timestamp", "sign-key-sha3-384", "artifact-sha3-384"}:
        continue
    data[key] = value.strip()

data["artifact-sha3-384"] = artifact_sha
print(json.dumps(data, indent=2))
PY

    rebuilt_assert=$(mktemp "${TMPDIR%/}/nimbus-preseed-assert.XXXXXX")
    snap sign -k my-key --update-timestamp "$rebuilt_assert_json" > "$rebuilt_assert"

    sudo cp "$rebuilt_preseed" "$preseed_tgz"
    sudo cp "$rebuilt_assert" "$preseed_assert"
    sudo mcopy -o -i "$seed_img" "$rebuilt_preseed" "::/systems/$system_name/preseed.tgz"
    sudo mcopy -o -i "$seed_img" "$rebuilt_assert" "::/systems/$system_name/preseed"

    loop_dev=$(sudo losetup --find --show "$img")
    seed_start=$(sudo sfdisk --json "$loop_dev" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for part in data.get("partitiontable", {}).get("partitions", []):
    if part.get("name") == "ubuntu-seed":
        print(part["start"])
        break
')
    sudo losetup -d "$loop_dev"
    if [ -z "$seed_start" ]; then
        echo "could not locate ubuntu-seed start sector in $img" >&2
        rm -f "$rebuilt_assert" "$rebuilt_assert_json"
        rm -f "$rebuilt_preseed"
        rm -rf "$workdir"
        return 1
    fi

    dd if="$seed_img" of="$img" bs=512 seek="$seed_start" conv=notrunc status=none
    rm -f "$rebuilt_assert" "$rebuilt_assert_json"
    rm -f "$rebuilt_preseed"
    rm -rf "$workdir"
}

inject_lxc_seed_image() {
    img=$1
    seed_tgz=$2
    loop_dev=
    mnt=

    echo "==> Injecting LXC seed image into nimbus-sideload partition..."

    loop_dev=$(sudo losetup --find --show "$img")
    data_start=$(sudo sfdisk --json "$loop_dev" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for part in data.get("partitiontable", {}).get("partitions", []):
    if part.get("name") == "nimbus-sideload":
        print(part["start"])
        break
')
    sudo losetup -d "$loop_dev"

    if [ -z "$data_start" ]; then
        echo "    Warning: nimbus-sideload partition not found — skipping LXC seed injection" >&2
        echo "    === DEBUG: sfdisk output ===" >&2
        loop_debug=$(sudo losetup --find --show "$img")
        sudo sfdisk --json "$loop_debug" >&2 || true
        sudo losetup -d "$loop_debug"
        echo "    === END DEBUG ===" >&2
        return 0
    fi

    offset=$((data_start * 512))
    mnt=$(mktemp -d "${TMPDIR%/}/nimbus-sideload-mnt.XXXXXX")

    if ! sudo mount -o loop,offset=$offset "$img" "$mnt"; then
        echo "    Warning: could not mount nimbus-sideload (offset $offset) — skipping LXC seed injection" >&2
        rmdir "$mnt"
        return 0
    fi

    dest="$mnt/lxc-seed"
    sudo mkdir -p "$dest"
    sudo cp "$seed_tgz" "$dest/nimbus-lxc-seed.tar.gz"
    sudo chown -R 0:0 "$dest"

    sudo umount "$mnt"
    rmdir "$mnt"

    echo "    LXC seed injected ($(du -sh "$seed_tgz" | cut -f1)) at nimbus-sideload/lxc-seed/"
}

inject_sideload_models() {
    img=$1
    cache_dir=$2
    loop_dev=
    mnt=

    echo "==> Injecting sideloaded models into nimbus-sideload partition..."

    loop_dev=$(sudo losetup --find --show "$img")
    data_start=$(sudo sfdisk --json "$loop_dev" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for part in data.get("partitiontable", {}).get("partitions", []):
    if part.get("name") == "nimbus-sideload":
        print(part["start"])
        break
')
    sudo losetup -d "$loop_dev"

    if [ -z "$data_start" ]; then
        echo "    Warning: nimbus-sideload partition not found — skipping model injection" >&2
        echo "    === DEBUG: sfdisk output ===" >&2
        loop_debug=$(sudo losetup --find --show "$img")
        sudo sfdisk --json "$loop_debug" >&2 || true
        sudo losetup -d "$loop_debug"
        echo "    === END DEBUG ===" >&2
        return 0
    fi

    offset=$((data_start * 512))
    mnt=$(mktemp -d "${TMPDIR%/}/nimbus-sideload-mnt.XXXXXX")

    if ! sudo mount -o loop,offset=$offset "$img" "$mnt"; then
        echo "    Warning: could not mount nimbus-sideload (offset $offset) — skipping model injection" >&2
        rmdir "$mnt"
        return 0
    fi

    sudo cp -a "$cache_dir/." "$mnt/"
    sudo chown -R 0:0 "$mnt"

    sudo umount "$mnt"
    rmdir "$mnt"

    echo "    Models injected from $cache_dir into $img (offset $offset)"
}

[ "$#" -ge 1 ] || usage
TARGET_MODEL=$1
shift

MODEL_JSON=$TARGET_MODEL.json
MODEL_ASSERTION=$TARGET_MODEL.model
OUTPUT_DIR=$TARGET_MODEL

case "$TARGET_MODEL" in
    nimbus-amd)
        EXTRA_SNAP=
        PRESEED_DEFAULT=1
        MODEL_JSON=nimbus-lemonade.json
        MODEL_ASSERTION=nimbus-lemonade.model
        ;;
    nimbus-lemonade)
        EXTRA_SNAP=
        PRESEED_DEFAULT=1
        ;;
    nimbus-gemma4)
        EXTRA_SNAP=
        PRESEED_DEFAULT=0
        ;;
    *)
        echo "unsupported model: $TARGET_MODEL" >&2
        usage
        ;;
esac

PRESEED=$PRESEED_DEFAULT
while [ "$#" -gt 0 ]; do
    case "$1" in
        --preseed)    PRESEED=1 ;;
        --no-preseed) PRESEED=0 ;;
        *)            echo "unknown flag: $1" >&2; usage ;;
    esac
    shift
done

if [ ! -f "$MODEL_JSON" ]; then
    echo "missing model file: $MODEL_JSON" >&2
    exit 1
fi

# When preseeding, ubuntu-image runs `snap-preseed sign` as root and snapd
# refuses to use the user-owned snap keyring in that case. Provide a root-
# owned copy of the keyring just for the preseed call. Skipped when
# preseed is off — model.json and system-user assertion signing run as the user.
if [ "$PRESEED" -eq 1 ]; then
    SNAP_GNUPG_HOME=${SNAP_GNUPG_HOME:-"$HOME/.snap/gnupg"}
    ROOT_GNUPG_HOME=$(mktemp -d)
    trap 'sudo rm -rf "$ROOT_GNUPG_HOME"' EXIT
    cp -a "$SNAP_GNUPG_HOME"/. "$ROOT_GNUPG_HOME"/
    find "$ROOT_GNUPG_HOME" \( -type s -o -name '*.lock' \) -delete
    sudo chown -R root:root "$ROOT_GNUPG_HOME"
fi

snap sign -k my-key "$MODEL_JSON" > "$MODEL_ASSERTION"

if [ -f ./user.json ]; then
    snap sign -k my-key ./user.json > ./user.assert
fi

USER_ASSERTIONS=
if [ -f ./user.assert ]; then
    USER_ASSERTIONS="--assertion ./user.assert"
fi

if [ -z "$USER_ASSERTIONS" ]; then
    echo "WARNING: no system-user assertions found, proceeding without custom users" >&2
fi

# ubuntu-image only accepts extra assertions such as system-user here.
# snap-declaration and snap-revision assertions are rejected, so a local snap
# passed via --snap will still seed as x1. Use a Store-published revision if
# you need an asserted snap revision in the image.
#
# --workdir keeps the intermediate seed/rootfs around so a failed component
# download or seed-too-small error can be diagnosed by inspecting
# build-workdir/. --debug surfaces ubuntu-image's per-step progress and any
# warnings (especially for component fetches).
#
# If the workdir already has ubuntu-image state from a previous interrupted
# run, resume instead of starting over — re-downloading the 5 GB gemma4
# model component on every retry is otherwise the slow path.
BUILD_WORKDIR="$(pwd)/../../build-workdir-$TARGET_MODEL"
RESUME_FLAG=""
if [ -d "$BUILD_WORKDIR" ] && [ -n "$(sudo ls -A "$BUILD_WORKDIR" 2>/dev/null)" ]; then
    echo "Resuming from existing workdir: $BUILD_WORKDIR"
    RESUME_FLAG="--resume"
else
    mkdir -p "$BUILD_WORKDIR"
    sudo chown root:root "$BUILD_WORKDIR"
fi

PRESEED_FLAGS=""
if [ "$PRESEED" -eq 1 ]; then
    echo "Building with --preseed (signing key: my-key)"
    PRESEED_FLAGS="--preseed --preseed-sign-key my-key"
else
    echo "Building without preseed — snaps will install on first boot"
fi

EXTRA_SNAP_FLAG=""
if [ -n "$EXTRA_SNAP" ]; then
    EXTRA_SNAP_FLAG="--snap $EXTRA_SNAP"
fi

BASE_IMAGE_SIZE_GB=22
MODEL_CACHE_DIR="$(pwd)/model-cache"
IMAGE_SIZE="${BASE_IMAGE_SIZE_GB}G"
if [ -d "$MODEL_CACHE_DIR" ]; then
    cache_size_kb=$(du -sk "$MODEL_CACHE_DIR" | cut -f1)
    cache_size_gb=$(( (cache_size_kb + 1024 * 1024 - 1) / (1024 * 1024) ))
    IMAGE_SIZE="$(( BASE_IMAGE_SIZE_GB + cache_size_gb ))G"
    echo "Sideload model-cache detected: scaling image size to $IMAGE_SIZE"
fi

set -- sudo env -u SUDO_UID -u SUDO_GID -u SUDO_USER
if [ "$PRESEED" -eq 1 ]; then
    set -- "$@" "SNAP_GNUPG_HOME=$ROOT_GNUPG_HOME"
    if [ -n "${GPG_PASSPHRASE:-}" ]; then
        set -- "$@" "GPG_PASSPHRASE=$GPG_PASSPHRASE"
    fi
fi
set -- "$@" ubuntu-image snap "$MODEL_ASSERTION"
if [ -n "$EXTRA_SNAP_FLAG" ]; then
    set -- "$@" $EXTRA_SNAP_FLAG
fi
set -- "$@" --image-size="$IMAGE_SIZE" --workdir "$BUILD_WORKDIR" --debug
if [ -f ./user.assert ]; then
    set -- "$@" --assertion ./user.assert
fi
if [ -n "$RESUME_FLAG" ]; then
    set -- "$@" "$RESUME_FLAG"
fi
if [ -n "$PRESEED_FLAGS" ]; then
    set -- "$@" $PRESEED_FLAGS
fi
"$@"

# With --workdir, ubuntu-image drops the final pc.img + seed.manifest into the
# workdir rather than cwd. Move them out and reclaim ownership before
# compressing.
for artifact in pc.img seed.manifest; do
    if [ -e "$BUILD_WORKDIR/$artifact" ]; then
        sudo mv "$BUILD_WORKDIR/$artifact" "./$artifact"
    fi
    if [ -e "$artifact" ]; then
        sudo chown "$(id -un):$(id -gn)" "$artifact"
    fi
done

PC_IMG_PATH="$(pwd)/pc.img"
SEED_MANIFEST_PATH="$(pwd)/seed.manifest"

if [ -e "$PC_IMG_PATH" ]; then
    case "$TARGET_MODEL" in
        nimbus-lemonade|nimbus-amd)
            inject_nm_lxd_unmanaged "$PC_IMG_PATH" "$BUILD_WORKDIR/volumes/pc/part2.img" "$BUILD_WORKDIR/root/systems" lemonade
            ;;
        *)
            inject_nm_lxd_unmanaged "$PC_IMG_PATH" "$BUILD_WORKDIR/volumes/pc/part2.img" "$BUILD_WORKDIR/root/systems"
            ;;
    esac
fi

LXC_SEED_PATH="$(pwd)/nimbus-lxc-seed.tar.gz"
if [ -f "$LXC_SEED_PATH" ] && [ -e "$PC_IMG_PATH" ]; then
    inject_lxc_seed_image "$PC_IMG_PATH" "$LXC_SEED_PATH"
elif [ -e "$PC_IMG_PATH" ]; then
    echo "==> No nimbus-lxc-seed.tar.gz found — skipping LXC seed injection"
    echo "    Run scripts/build-lxc-seed.sh first to enable offline first-boot bootstrap."
fi

MODEL_CACHE_DIR="$(pwd)/model-cache"
if [ -d "$MODEL_CACHE_DIR" ] && [ -e "$PC_IMG_PATH" ]; then
    inject_sideload_models "$PC_IMG_PATH" "$MODEL_CACHE_DIR"
fi


if [ ! -e "$PC_IMG_PATH" ]; then
    echo "pc.img is missing after injection step" >&2
    exit 1
fi

# Optimize for the smallest .xz output; this is slower than the default preset.
#xz -v -9e -T1 pc.img
rm -f pc.img.xz
xz -v -7 -T0 "$PC_IMG_PATH"

mkdir -p "$OUTPUT_DIR"

for artifact in "$MODEL_ASSERTION" pc.img.xz seed.manifest; do
    if [ -e "$artifact" ]; then
        rm -f "$OUTPUT_DIR/$artifact"
        mv "$artifact" "$OUTPUT_DIR/$artifact"
    fi
done
