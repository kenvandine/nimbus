#!/bin/bash
# Build a pre-configured LXC container image with all nimbus runtime packages
# pre-installed, then export and package it as nimbus-lxc-seed.tar.gz for
# seeding into the Ubuntu Core disk image via model/build.sh.
#
# Usage: ./scripts/build-lxc-seed.sh [output-dir]
#   output-dir  where to write nimbus-lxc-seed.tar.gz  (default: current dir)
#
# Prerequisites: lxd snap installed and initialised on the build machine.
# The exported tarball is typically 500-900 MB (compressed squashfs rootfs).

set -euo pipefail

OUTPUT_DIR="${1:-.}"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(realpath "$OUTPUT_DIR")"

CONTAINER="nimbus-seed-builder-$$"
ALIAS="nimbus-runtime"

# Work directory must be inside $HOME so the lxd snap (strictly confined,
# home interface only) can write the exported image files there.
WORK="$OUTPUT_DIR/.lxc-build-$$"
mkdir -p "$WORK"

cleanup() {
    lxc delete --force "$CONTAINER" 2>/dev/null || true
    lxc image delete "$ALIAS" 2>/dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> Launching builder container: $CONTAINER"
lxc launch ubuntu:24.04 "$CONTAINER"

echo "==> Waiting for cloud-init / network..."
lxc exec "$CONTAINER" -- cloud-init status --wait 2>/dev/null || sleep 10

echo "==> Installing runtime packages..."
lxc exec "$CONTAINER" -- bash -c "
    set -euo pipefail
    apt-get update -q
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q \
        docker.io docker-compose-v2 python3 python3-venv git curl ca-certificates
    apt-get clean
    rm -rf /var/lib/apt/lists/*
    # Signal to nimbus that APT packages are already present.
    mkdir -p /var/lib/nimbus
    touch /var/lib/nimbus/.packages-preinstalled
"

echo "==> Stopping container..."
lxc stop "$CONTAINER"

# Remove an existing local image with the same alias so publish doesn't fail.
lxc image delete "$ALIAS" 2>/dev/null || true

echo "==> Publishing image as '$ALIAS'..."
lxc publish "$CONTAINER" --alias "$ALIAS" description="Nimbus pre-built runtime"

echo "==> Exporting image..."
# cd into WORK so lxc (lxd snap, strictly confined) writes files to a path
# within $HOME rather than /tmp, which snap confinement blocks.
(cd "$WORK" && lxc image export "$ALIAS" nimbus-runtime)

meta="$WORK/nimbus-runtime.tar.gz"
# Rootfs has the image fingerprint embedded in the filename (squashfs or tar.gz).
rootfs=$(find "$WORK" -name 'nimbus-runtime.*' ! -name 'nimbus-runtime.tar.gz' | head -1)

if [ ! -f "$meta" ] || [ -z "$rootfs" ]; then
    echo "ERROR: exported image files not found in $WORK:" >&2
    ls -lh "$WORK" >&2
    exit 1
fi

echo "==> Packaging as nimbus-lxc-seed.tar.gz..."
echo "    meta:   $(basename "$meta")  ($(du -sh "$meta" | cut -f1))"
echo "    rootfs: $(basename "$rootfs")  ($(du -sh "$rootfs" | cut -f1))"

# Store under stable names so the Python importer knows what to open.
cp "$meta"   "$WORK/meta.tar.gz"
cp "$rootfs" "$WORK/rootfs"

tar -C "$WORK" -czf "$WORK/nimbus-lxc-seed.tar.gz" meta.tar.gz rootfs

cp "$WORK/nimbus-lxc-seed.tar.gz" "$OUTPUT_DIR/nimbus-lxc-seed.tar.gz"

echo ""
echo "==> Done: $OUTPUT_DIR/nimbus-lxc-seed.tar.gz  ($(du -sh "$OUTPUT_DIR/nimbus-lxc-seed.tar.gz" | cut -f1))"
echo "    Run model/build.sh — it will inject this file into the pc.img automatically."
