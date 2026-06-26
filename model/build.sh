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
snap connect nimbus:network-control; \
snap connect nimbus:network-observe; \
snap connect nimbus:system-observe; \
snap set system hostname=nimbus; \
hostnamectl set-hostname --transient nimbus || true; \
snap set system service.systemd-resolved.multicast-dns=yes; \
systemctl restart systemd-resolved || true; \
NM_DROPIN=/var/snap/network-manager/current/conf.d/90-lxd-unmanaged.conf; \
NM_CONTENT="[keyfile]\nunmanaged-devices=interface-name:lxdbr*;interface-name:veth*\n"; \
mkdir -p "$(dirname $NM_DROPIN)" || true; \
if [ ! -f "$NM_DROPIN" ] || [ "$(cat $NM_DROPIN)" != "$(printf "$NM_CONTENT")" ]; then \
  printf "$NM_CONTENT" > "$NM_DROPIN" && snap restart network-manager || true; \
fi; \
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
        GADGET_SNAP=../../pc-amd64-gadget/pc_amd-24-0.2_amd64.snap
        PRESEED_DEFAULT=1
        MODEL_JSON=nimbus-lemonade.json
        MODEL_ASSERTION=nimbus-lemonade.model
        ;;
    nimbus-lemonade)
        EXTRA_SNAP=
        GADGET_SNAP=../../pc-amd64-gadget/pc_amd-24-0.2_amd64.snap
        PRESEED_DEFAULT=1
        ;;
    nimbus-gemma4)
        EXTRA_SNAP=
        GADGET_SNAP=../../pc-amd64-gadget/pc_amd-24-0.2_amd64.snap
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
set -- "$@" ubuntu-image snap "$MODEL_ASSERTION" --snap "$GADGET_SNAP"
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
