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

    seed_start=$(
        sfdisk --json "$img" | python3 -c '
import json, sys
data = json.load(sys.stdin)
for part in data.get("partitiontable", {}).get("partitions", []):
    if part.get("name") == "ubuntu-seed":
        print(part["start"])
        break
'
    )
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
        GADGET_SNAP=../../pc-amd64-gadget/pc_lemonade-24-0.2_amd64.snap
        PRESEED_DEFAULT=1
        ;;
    nimbus-gemma4)
        EXTRA_SNAP=
        GADGET_SNAP=../../pc-amd64-gadget/pc_gemma4-24-0.2_amd64.snap
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
    trap 'rm -rf "$ROOT_GNUPG_HOME"' EXIT
    cp -a "$SNAP_GNUPG_HOME"/. "$ROOT_GNUPG_HOME"/
    find "$ROOT_GNUPG_HOME" \( -type s -o -name '*.lock' \) -delete
    sudo chown -R root:root "$ROOT_GNUPG_HOME"
fi

snap sign -k my-key "$MODEL_JSON" > "$MODEL_ASSERTION"

if [ -f ./kenvandine.json ]; then
    snap sign -k my-key ./kenvandine.json > ./kenvandine.assert
fi

if [ -f ./krishna.json ]; then
    snap sign -k my-key ./krishna.json > ./krishna.assert
fi

USER_ASSERTIONS=
for assertion in ./kenvandine.assert ./krishna.assert; do
    if [ -f "$assertion" ]; then
        USER_ASSERTIONS="$USER_ASSERTIONS --assertion $assertion"
    fi
done

if [ -z "$USER_ASSERTIONS" ]; then
    echo "missing system-user assertion: create kenvandine.json/kenvandine.assert or krishna.assert" >&2
    exit 1
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
ENV_VARS=""
if [ "$PRESEED" -eq 1 ]; then
    echo "Building with --preseed (signing key: my-key)"
    PRESEED_FLAGS="--preseed --preseed-sign-key my-key"
    ENV_VARS="SNAP_GNUPG_HOME=$ROOT_GNUPG_HOME"
else
    echo "Building without preseed — snaps will install on first boot"
fi

EXTRA_SNAP_FLAG=""
if [ -n "$EXTRA_SNAP" ]; then
    EXTRA_SNAP_FLAG="--snap $EXTRA_SNAP"
fi

set -- sudo env -u SUDO_UID -u SUDO_GID -u SUDO_USER
if [ -n "$ENV_VARS" ]; then
    set -- "$@" "$ENV_VARS"
fi
set -- "$@" ubuntu-image snap "$MODEL_ASSERTION" --snap "$GADGET_SNAP"
if [ -n "$EXTRA_SNAP_FLAG" ]; then
    set -- "$@" $EXTRA_SNAP_FLAG
fi
set -- "$@" --image-size=22G --workdir "$BUILD_WORKDIR" --debug
for assertion in ./kenvandine.assert ./krishna.assert; do
    if [ -f "$assertion" ]; then
        set -- "$@" --assertion "$assertion"
    fi
done
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
    inject_nm_lxd_unmanaged "$PC_IMG_PATH" "$BUILD_WORKDIR/volumes/pc/part2.img" "$BUILD_WORKDIR/root/systems"
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
