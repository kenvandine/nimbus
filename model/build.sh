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
# Optimize for the smallest .xz output; this is slower than the default preset.
#xz -v -9e -T1 pc.img
rm -f pc.img.xz
xz -v -7 -T0 pc.img

mkdir -p "$OUTPUT_DIR"

for artifact in "$MODEL_ASSERTION" pc.img.xz seed.manifest; do
    if [ -e "$artifact" ]; then
        rm -f "$OUTPUT_DIR/$artifact"
        mv "$artifact" "$OUTPUT_DIR/$artifact"
    fi
done
