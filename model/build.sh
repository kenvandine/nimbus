#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
    echo "usage: $0 nimbus-lemonade|nimbus-gemma4" >&2
    exit 1
fi

TARGET_MODEL=$1
MODEL_JSON=$TARGET_MODEL.json
MODEL_ASSERTION=$TARGET_MODEL.model
OUTPUT_DIR=$TARGET_MODEL

case "$TARGET_MODEL" in
    nimbus-lemonade)
        EXTRA_SNAP=../../../../lemonade-sdk/lemonade-server-snap/lemonade-server_v10.4.0-7-g7c001dc5fc_amd64.snap
        GADGET_SNAP=../../pc-amd64-gadget/pc_lemonade-24-0.2_amd64.snap
        ;;
    nimbus-gemma4)
        EXTRA_SNAP=
        GADGET_SNAP=../../pc-amd64-gadget/pc_gemma4-24-0.2_amd64.snap
        ;;
    *)
        echo "unsupported model: $TARGET_MODEL" >&2
        echo "supported models: nimbus-lemonade, nimbus-gemma4" >&2
        exit 1
        ;;
esac

if [ ! -f "$MODEL_JSON" ]; then
    echo "missing model file: $MODEL_JSON" >&2
    exit 1
fi

NIMBUS_SNAP=$(ls ../nimbus*.snap | head -n1)
SNAP_GNUPG_HOME=${SNAP_GNUPG_HOME:-"$HOME/.snap/gnupg"}
ROOT_GNUPG_HOME=$(mktemp -d)

cleanup() {
    rm -rf "$ROOT_GNUPG_HOME"
}

trap cleanup EXIT

# ubuntu-image runs with sudo for image creation, so preseed signing also runs
# as root. GnuPG refuses to use the user-owned snap keyring in that case, so
# provide a root-owned copy just for this invocation.
cp -a "$SNAP_GNUPG_HOME"/. "$ROOT_GNUPG_HOME"/
find "$ROOT_GNUPG_HOME" \( -type s -o -name '*.lock' \) -delete
sudo chown -R root:root "$ROOT_GNUPG_HOME"

snap sign -k my-key "$MODEL_JSON" > "$MODEL_ASSERTION"

if [ -f ./user.json ]; then
    snap sign -k my-key ./user.json > ./user.assert
elif [ ! -f ./user.assert ]; then
    echo "missing user assertion: create user.json or user.assert" >&2
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
BUILD_WORKDIR="$(pwd)/build-workdir-$TARGET_MODEL"
RESUME_FLAG=""
if [ -d "$BUILD_WORKDIR" ] && [ -n "$(sudo ls -A "$BUILD_WORKDIR" 2>/dev/null)" ]; then
    echo "Resuming from existing workdir: $BUILD_WORKDIR"
    RESUME_FLAG="--resume"
else
    mkdir -p "$BUILD_WORKDIR"
    sudo chown root:root "$BUILD_WORKDIR"
fi

if [ -n "$EXTRA_SNAP" ]; then
    sudo env -u SUDO_UID -u SUDO_GID -u SUDO_USER \
        SNAP_GNUPG_HOME="$ROOT_GNUPG_HOME" \
        ubuntu-image snap "$MODEL_ASSERTION" \
        --snap "$GADGET_SNAP" \
        --snap "$NIMBUS_SNAP" \
        --snap "$EXTRA_SNAP" \
        --image-size=22G \
        --assertion ./user.assert \
        --workdir "$BUILD_WORKDIR" \
        --debug \
        $RESUME_FLAG \
        --preseed --preseed-sign-key my-key
else
    sudo env -u SUDO_UID -u SUDO_GID -u SUDO_USER \
        SNAP_GNUPG_HOME="$ROOT_GNUPG_HOME" \
        ubuntu-image snap "$MODEL_ASSERTION" \
        --snap "$GADGET_SNAP" \
        --snap "$NIMBUS_SNAP" \
        --image-size=22G \
        --assertion ./user.assert \
        --workdir "$BUILD_WORKDIR" \
        --debug \
        $RESUME_FLAG \
        --preseed --preseed-sign-key my-key
fi

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
