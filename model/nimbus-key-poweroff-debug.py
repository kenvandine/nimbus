#!/usr/bin/env python3
"""Debug version of nimbus-key-poweroff.py — confirm KEY_F23 is seen.

Copy to a test device and run as root:

    python3 nimbus-key-poweroff-debug.py                 # monitor, DRY RUN
    python3 nimbus-key-poweroff-debug.py --hold 5        # 5s hold instead of 20
    python3 nimbus-key-poweroff-debug.py --run           # actually run the action
    python3 nimbus-key-poweroff-debug.py --all           # log every key press/release
    python3 nimbus-key-poweroff-debug.py --device /dev/input/event2
    python3 nimbus-key-poweroff-debug.py --key 193       # only a specific code

Use --all if you are not sure what the button maps to: press it and read off
the code from the output. (The chassis reset button emits KEY_F23 (193)
chorded with KEY_LEFTMETA (125).)

Same event logic as the installed watcher
(/writable/system-data/nimbus-key-poweroff.py), but by default it only logs
what it would do instead of running the action, and it prints a summary on
Ctrl-C / SIGTERM.
"""

import argparse
import glob
import os
import select
import signal
import struct
import subprocess
import sys
import time

KEY_F23 = 193         # KEY_F23 (input-event-codes.h); reset button emits it with LEFTMETA (125) + LEFTSHIFT (42)
EV_KEY = 0x01
# struct input_event (64-bit): 2x int64 timeval, u16 type, u16 code, s32 value
INPUT_EVENT = struct.Struct(("<" if sys.byteorder == "little" else ">") + "qqHHl")
DEFAULT_KEY_CODES = {KEY_F23}
READ_CHUNK = 4096


def parse_key_codes(raw, default):
    raw = (raw or "").strip()
    if not raw:
        return set(default)
    codes = set()
    for tok in raw.replace(",", " ").split():
        try:
            codes.add(int(tok))
        except ValueError:
            print("warning: ignoring invalid key code %r" % tok, file=sys.stderr)
    return codes or set(default)


def device_names():
    """Map /dev/input/eventX -> human-readable name via sysfs."""
    names = {}
    for entry in glob.glob("/sys/class/input/input*/event*"):
        base = os.path.basename(os.path.dirname(entry))   # inputN
        ev = os.path.basename(entry)                      # eventM
        try:
            with open("/sys/class/input/%s/name" % base) as f:
                names["/dev/input/%s" % ev] = f.read().strip()
        except OSError:
            pass
    return names


def main():
    ap = argparse.ArgumentParser(description="confirm KEY_F23 events reach the system")
    ap.add_argument("--hold", type=float, default=20.0,
                    help="seconds held before the action triggers (default 20)")
    ap.add_argument("--key", default="193",
                    help="comma-separated evdev key code(s) to watch "
                         "(default %(default)s: 193 = KEY_F23, emitted by the "
                         "chassis reset button; run with --all, press the "
                         "button, and read off the code)")
    ap.add_argument("--action", default="systemctl poweroff -i",
                    help="action to run when the hold threshold is met (default %(default)s)")
    ap.add_argument("--run", action="store_true",
                    help="actually run the action (default: dry run, log only)")
    ap.add_argument("--all", action="store_true",
                    help="log every key press/release on every device, not just F23")
    ap.add_argument("--device", default=None,
                    help="watch only this event device (default: all of /dev/input/event*)")
    args = ap.parse_args()

    names = device_names()
    key_codes = parse_key_codes(args.key, DEFAULT_KEY_CODES)
    devices = {}        # path -> fd
    pressed_at = None   # monotonic time of the current F23 press
    pressed_path = None # device that reported the current press
    fired = False       # threshold already hit for the current press
    stats = {"press": 0, "release": 0, "fire": 0}

    def out(msg):
        print("%s %s" % (time.strftime("%H:%M:%S"), msg), flush=True)

    def label(path):
        name = names.get(path)
        return "%s (%s)" % (path, name) if name else path

    def drop(path, reason):
        fd = devices.pop(path, None)
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        out("stopped watching %s (%s)" % (label(path), reason))
        if pressed_path == path:
            release("device removed while held")

    def rescan():
        pattern = args.device or "/dev/input/event*"
        present = set(glob.glob(pattern))
        for path in sorted(set(devices) - present):
            drop(path, "device removed")
        for path in sorted(present):
            if path in devices:
                continue
            try:
                devices[path] = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            except OSError as exc:
                out("cannot open %s: %s" % (path, exc))
                continue
            out("watching %s" % label(path))

    def release(why):
        nonlocal pressed_at, pressed_path, fired
        if pressed_at is None:
            return
        held = time.monotonic() - pressed_at
        stats["release"] += 1
        if fired:
            out("F23 released after %.1fs (threshold already met, action %s)"
                % (held, "ran" if args.run else "would have run"))
        else:
            out("F23 released after %.1fs of %.0fs - action cancelled" % (held, args.hold))
        pressed_at = None
        pressed_path = None
        fired = False

    def finish(signum, frame):
        out("--- F23 presses: %d, releases: %d, threshold hits: %d (%s) ---"
            % (stats["press"], stats["release"], stats["fire"],
               "action ran" if args.run else "dry run"))
        for fd in list(devices.values()):
            try:
                os.close(fd)
            except OSError:
                pass
        sys.exit(0)

    signal.signal(signal.SIGINT, finish)
    signal.signal(signal.SIGTERM, finish)

    out("monitoring %s | key(s) %s (F23) hold=%.0fs action=%r mode=%s"
        % (args.device or "all /dev/input/event*",
           ",".join(str(c) for c in sorted(key_codes)), args.hold,
           args.action, "RUN" if args.run else "DRY RUN"))
    if args.all:
        out("logging all key press/release events (auto-repeat suppressed)")
    out("press the F23 button now and watch for 'F23 pressed' lines; Ctrl-C to stop")

    hinted = False
    last_activity = time.monotonic()

    while True:
        now = time.monotonic()
        if not hinted and now - last_activity > 30:
            hinted = True
            out("no key events seen yet on the watched device(s)")
            out("if the button is not on this device, re-run without --device to watch all of them")
            out("also close any other input tool (e.g. 'libinput debug-events') - it grabs the devices exclusively")
        if pressed_at is not None and not fired and now - pressed_at >= args.hold:
            fired = True
            stats["fire"] += 1
            if args.run:
                out("F23 held %.0fs - running: %s" % (args.hold, args.action))
                try:
                    rc = subprocess.call(args.action, shell=True)
                    out("action exited with code %d" % rc)
                except Exception as exc:
                    out("error running action: %s" % exc)
            else:
                out("F23 held %.0fs - DRY RUN, would execute: %s" % (args.hold, args.action))

        rescan()
        if not devices:
            out("no input devices present, retrying in 5s")
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
                if ev_type != EV_KEY:
                    continue
                last_activity = time.monotonic()
                if value == 2:          # auto-repeat: skip in the --all dump
                    continue
                if args.all and code not in key_codes:
                    out("%s: key %d %s" % (label(path), code,
                                           "release" if value == 0 else "press"))
                if code not in key_codes:
                    continue
                if value == 0:
                    release("released")
                elif pressed_at is None:
                    # value 1 (press) or 2 (auto-repeat) on an untracked key
                    pressed_at = time.monotonic()
                    pressed_path = path
                    fired = False
                    stats["press"] += 1
                    out("F23 (code %d) pressed on %s - action triggers in %.0fs if not released"
                        % (code, label(path), args.hold))


if __name__ == "__main__":
    main()
