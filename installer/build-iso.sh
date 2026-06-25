#!/bin/bash
set -euo pipefail

usage() {
    cat >&2 <<EOF
Usage: $0 <input-iso> <output-iso> <pc-img-xz>

Builds a Nimbus appliance installer ISO from an Ubuntu 26.04 server ISO:
  - copies install.sh and pc.img.xz to the root of the ISO (visible at /cdrom)
  - injects a systemd unit that runs install.sh on boot
  - masks subiquity so the live installer never starts

<pc-img-xz> must be an xz-compressed raw disk image. install.sh streams
it through xzcat into dd at install time.

Requires livefs-edit (from https://github.com/mwhudson/livefs-editor) and root.
EOF
    exit 1
}

[ "$#" -eq 3 ] || usage

INPUT_ISO="$1"
OUTPUT_ISO="$2"
PC_IMG_XZ="$3"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SCRIPT="${SCRIPT_DIR}/install.sh"
CLEAR_UEFI_SCRIPT="${SCRIPT_DIR}/clear-ubuntu-uefi-entries.sh"
REQUIREMENTS="${SCRIPT_DIR}/requirements.txt"
VENV_DIR="${SCRIPT_DIR}/.venv"

for f in "$INPUT_ISO" "$INSTALL_SCRIPT" "$CLEAR_UEFI_SCRIPT" "$PC_IMG_XZ" "$REQUIREMENTS"; do
    if [ ! -f "$f" ]; then
        echo "Error: required file not found: $f" >&2
        exit 1
    fi
done

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: must run as root (livefs-edit requires it)." >&2
    exit 1
fi

ensure_system_packages() {
    local -A pkg_for_cmd=(
        [xorriso]=xorriso
        [mksquashfs]=squashfs-tools
        [unsquashfs]=squashfs-tools
        [python3]=python3
    )
    local -a missing=()
    local cmd
    for cmd in "${!pkg_for_cmd[@]}"; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            missing+=("${pkg_for_cmd[$cmd]}")
        fi
    done
    if command -v python3 >/dev/null 2>&1 && ! python3 -m venv --help >/dev/null 2>&1; then
        missing+=(python3-venv)
    fi
    if [ "${#missing[@]}" -eq 0 ]; then
        return
    fi
    local -a unique
    readarray -t unique < <(printf '%s\n' "${missing[@]}" | sort -u)
    if ! command -v apt-get >/dev/null 2>&1; then
        echo "Error: missing packages and apt-get unavailable: ${unique[*]}" >&2
        echo "Install them manually and rerun." >&2
        exit 1
    fi
    echo "Installing missing system packages: ${unique[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${unique[@]}"
}

ensure_system_packages

VENV_STAMP="$VENV_DIR/.installed-from-requirements"
if [ ! -f "$VENV_STAMP" ] || [ "$REQUIREMENTS" -nt "$VENV_STAMP" ]; then
    echo "Setting up Python venv at $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
    "$VENV_DIR/bin/pip" install --upgrade pip
    "$VENV_DIR/bin/pip" install -r "$REQUIREMENTS"
    touch "$VENV_STAMP"
fi

# The livefs-edit==0.0.4 wheel ships a broken console-script entry point
# (livefs_edit:__main__.main instead of livefs_edit.__main__:main), so
# invoke the module directly via `python -m livefs_edit`.
LIVEFS_EDIT=("$VENV_DIR/bin/python3" -m livefs_edit)

# Patch livefs-edit's repack_iso so the output ISO opts in to ISO 9660 Level 3
# multi-extent files (-iso-level 3). The default Level 2 caps single files at
# 4 GiB and our pc.img.xz is well above that with the gemma4 model component
# preseeded. The patch is idempotent — we look for our marker before applying.
CONTEXT_PY=$(find "$VENV_DIR/lib" -path '*/livefs_edit/context.py' | head -1)
if [ -n "$CONTEXT_PY" ] && ! grep -q "'-iso-level', '3'" "$CONTEXT_PY"; then
    python3 - "$CONTEXT_PY" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
needle = "['xorriso', '-as', 'mkisofs'] + opts +"
inject = "['xorriso', '-as', 'mkisofs', '-iso-level', '3'] + opts +"
assert needle in src, f"could not find xorriso line in {path}"
open(path, "w").write(src.replace(needle, inject))
print(f"Patched {path} for iso-level 3")
PY
fi

# Patch livefs-edit's install_packages to strip cdrom apt sources before
# running apt-get update — /cdrom is not mounted in the chroot so the source
# always fails, causing apt-get update to exit non-zero even when all real
# repos succeed.
ACTIONS_PY=$(find "$VENV_DIR/lib" -path '*/livefs_edit/actions.py' | head -1)
if [ -n "$ACTIONS_PY" ] && ! grep -q "cdrom is not mounted" "$ACTIONS_PY"; then
    python3 - "$ACTIONS_PY" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
needle = "    cache = Cache()"
inject = (
    "    # Remove cdrom apt sources — /cdrom is not mounted in the chroot.\n"
    "    import glob as _glob, os as _os\n"
    "    for _f in (_glob.glob(overlay + '/etc/apt/sources.list.d/cdrom*') +\n"
    "               _glob.glob(overlay + '/etc/apt/sources.list.d/*cdrom*')):\n"
    "        try:\n"
    "            _os.unlink(_f)\n"
    "        except OSError:\n"
    "            pass\n"
    "    _sources = overlay + '/etc/apt/sources.list'\n"
    "    if _os.path.exists(_sources):\n"
    "        try:\n"
    "            with open(_sources, 'r') as _f:\n"
    "                _lines = _f.readlines()\n"
    "            with open(_sources, 'w') as _f:\n"
    "                for _line in _lines:\n"
    "                    if 'cdrom:' in _line:\n"
    "                        _f.write('# ' + _line)\n"
    "                    else:\n"
    "                        _f.write(_line)\n"
    "        except Exception:\n"
    "            pass\n"
    "    cache = Cache()"
)
assert needle in src, f"could not find cache = Cache() line in {path}"
open(path, "w").write(src.replace(needle, inject))
print(f"Patched {path} to remove cdrom apt sources file")
PY
fi

INPUT_ISO_ABS="$(readlink -f "$INPUT_ISO")"
OUTPUT_ISO_ABS="$(readlink -m "$OUTPUT_ISO")"
INSTALL_SCRIPT_ABS="$(readlink -f "$INSTALL_SCRIPT")"
CLEAR_UEFI_SCRIPT_ABS="$(readlink -f "$CLEAR_UEFI_SCRIPT")"
PC_IMG_XZ_ABS="$(readlink -f "$PC_IMG_XZ")"

WORK="$(mktemp -d)"
ISO_INSPECT_MNT="$WORK/iso-inspect"
cleanup() {
    if mountpoint -q "$ISO_INSPECT_MNT" 2>/dev/null; then
        umount "$ISO_INSPECT_MNT" || umount -l "$ISO_INSPECT_MNT" || true
    fi
    rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$ISO_INSPECT_MNT"
mount -o loop,ro "$INPUT_ISO_ABS" "$ISO_INSPECT_MNT"
SQUASHFS_LAYERS=()
for f in "$ISO_INSPECT_MNT"/casper/*.squashfs; do
    [ -e "$f" ] || continue
    SQUASHFS_LAYERS+=("$(basename "$f" .squashfs)")
done
umount "$ISO_INSPECT_MNT"

if [ "${#SQUASHFS_LAYERS[@]}" -eq 0 ]; then
    echo "Error: no /casper/*.squashfs files found in $INPUT_ISO" >&2
    exit 1
fi

# Top layer to keep. Casper interprets the dot-separated name as a
# chain, so this also implies all shorter prefixes. The default skips
# the subiquity installer layer entirely, since we don't use subiquity
# and the snaps it contains (subiquity, snapd, core24) make the live
# boot slow and the ISO ~140 MB larger.
LAYERFS_TOP="${NIMBUS_LAYERFS_PATH:-ubuntu-server-minimal.ubuntu-server}"

KEEP_LAYERS=()
IFS='.' read -ra _parts <<< "$LAYERFS_TOP"
_prefix=""
for _p in "${_parts[@]}"; do
    [ -z "$_prefix" ] && _prefix="$_p" || _prefix="$_prefix.$_p"
    KEEP_LAYERS+=("$_prefix")
done

DROP_LAYERS=()
for layer in "${SQUASHFS_LAYERS[@]}"; do
    keep=0
    for k in "${KEEP_LAYERS[@]}"; do
        [ "$layer" = "$k" ] && { keep=1; break; }
    done
    [ "$keep" -eq 0 ] && DROP_LAYERS+=("$layer")
done

# Verify every layer we want to keep actually exists in the source ISO.
for k in "${KEEP_LAYERS[@]}"; do
    found=0
    for layer in "${SQUASHFS_LAYERS[@]}"; do
        [ "$layer" = "$k" ] && { found=1; break; }
    done
    if [ "$found" -eq 0 ]; then
        echo "Error: NIMBUS_LAYERFS_PATH chain requires layer '$k' but it's not in the ISO." >&2
        echo "Available: ${SQUASHFS_LAYERS[*]}" >&2
        exit 1
    fi
done

# Choose which squashfs layer to inject the systemd unit into. Default
# to the shortest-named layer in KEEP (the base squashfs has
# /etc/resolv.conf which edit-squashfs needs). Override with
# NIMBUS_SQUASHFS env var; it must be one of the kept layers.
INJECT_LAYER="${NIMBUS_SQUASHFS:-}"
if [ -z "$INJECT_LAYER" ]; then
    INJECT_LAYER="${KEEP_LAYERS[0]}"
    for layer in "${KEEP_LAYERS[@]}"; do
        if [ "${#layer}" -lt "${#INJECT_LAYER}" ]; then
            INJECT_LAYER="$layer"
        fi
    done
else
    in_keep=0
    for k in "${KEEP_LAYERS[@]}"; do
        [ "$k" = "$INJECT_LAYER" ] && { in_keep=1; break; }
    done
    if [ "$in_keep" -eq 0 ]; then
        echo "Error: NIMBUS_SQUASHFS=$INJECT_LAYER would be dropped. Pick one of: ${KEEP_LAYERS[*]}" >&2
        exit 1
    fi
fi

echo "Squashfs layers in ISO: ${SQUASHFS_LAYERS[*]}"
echo "Keeping layers:         ${KEEP_LAYERS[*]}"
if [ "${#DROP_LAYERS[@]}" -gt 0 ]; then
    echo "Dropping layers:        ${DROP_LAYERS[*]}"
fi
echo "Injecting systemd unit into: $INJECT_LAYER"

# Build the rm targets for dropped layers.
DROP_FILES=""
for d in "${DROP_LAYERS[@]}"; do
    for ext in squashfs manifest manifest.full size; do
        DROP_FILES+=" new/iso/casper/$d.$ext"
    done
done

SERVICE_FILE="$WORK/nimbus-install.service"
cat > "$SERVICE_FILE" <<'EOF'
[Unit]
Description=Nimbus appliance installer
# Run before getty grabs tty1; if our service fails, getty starts up
# afterward so the operator can log in to investigate.
Before=getty@tty1.service getty.target
Conflicts=getty@tty1.service
Wants=systemd-udev-settle.service
After=systemd-udev-settle.service

[Service]
Type=oneshot
ExecStart=/cdrom/install.sh
StandardInput=tty
StandardOutput=tty
StandardError=tty
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes

[Install]
WantedBy=multi-user.target
EOF

# livefs-edit extracts ISO contents under new/iso/ in its temp dir, so
# new/iso/<name> is the path at the root of the resulting ISO (visible at
# /cdrom/<name> on the booted live system). --edit-squashfs <name> mounts
# the named squashfs as an overlay at new/<name>/; writes there are
# repacked into casper/<name>.squashfs on save. We use --shell to make
# the systemd .wants/ directory and the enable symlink, since the 0.0.4
# cp action neither creates parent directories nor copies symlinks.
#
# /pool (subiquity's offline package archive, ~1.2 GB), /dists (apt
# metadata for that pool), and /md5sum.txt are all subiquity-only and
# get deleted. The dropped squashfs layers and their sidecar files are
# also deleted from new/iso/casper. layerfs-path on the kernel cmdline
# tells casper to mount only the chain we keep.
"${LIVEFS_EDIT[@]}" "$INPUT_ISO_ABS" "$OUTPUT_ISO_ABS" \
    --cp "$INSTALL_SCRIPT_ABS" new/iso/install.sh \
    --cp "$CLEAR_UEFI_SCRIPT_ABS" new/iso/clear-ubuntu-uefi-entries.sh \
    --cp "$PC_IMG_XZ_ABS" new/iso/pc.img.xz \
    --install-packages efibootmgr \
    --edit-squashfs "$INJECT_LAYER" \
    --shell "mkdir -p new/$INJECT_LAYER/etc/systemd/system/multi-user.target.wants" \
    --cp "$SERVICE_FILE" "new/$INJECT_LAYER/etc/systemd/system/nimbus-install.service" \
    --shell "ln -sf ../nimbus-install.service new/$INJECT_LAYER/etc/systemd/system/multi-user.target.wants/nimbus-install.service" \
    --shell "rm -rf new/iso/pool new/iso/dists new/iso/md5sum.txt $DROP_FILES" \
    --shell "sed -i 's|\"Try or Install Ubuntu Server\"|\"Install Your AI Appliance\"|' new/iso/boot/grub/grub.cfg new/iso/boot/grub/loopback.cfg" \
    --add-cmdline-arg "layerfs-path=${LAYERFS_TOP}.squashfs" \
    --add-cmdline-arg "cloud-init=disabled" \
    --add-cmdline-arg "quiet" \
    --add-cmdline-arg "loglevel=3" \
    --add-cmdline-arg "systemd.show_status=false" \
    --add-cmdline-arg "rd.systemd.show_status=false" \
    --add-cmdline-arg "vt.global_cursor_default=0" \
    --add-cmdline-arg "systemd.mask=systemd-networkd-wait-online.service" \
    --add-cmdline-arg "systemd.mask=NetworkManager-wait-online.service" \
    --add-cmdline-arg "systemd.mask=systemd-time-wait-sync.service" \
    --add-cmdline-arg "systemd.mask=snap.subiquity.subiquity-server.service" \
    --add-cmdline-arg "systemd.mask=snap.subiquity.subiquity-service.service"

echo "Built $OUTPUT_ISO_ABS"
