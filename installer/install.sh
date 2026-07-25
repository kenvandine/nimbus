#!/bin/bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${SCRIPT_DIR}/pc.img.xz"

poweroff_now() {
    local message="$1"

    echo
    echo "$message"
    echo

    sync
    exec /sbin/poweroff
}

if command -v efibootmgr >/dev/null 2>&1; then
    bash "${SCRIPT_DIR}/clear-ubuntu-uefi-entries.sh" || true
fi

echo "Nimbus Appliance Installer"
echo "Writing the Nimbus appliance OS image to the internal disk. All existing data on the target disk will be ERASED."
echo

mapfile -t DRIVES < <(lsblk -d -n -o NAME,TYPE,TRAN \
    | awk '$2 == "disk" && $3 != "usb" && $1 !~ /^fd[0-9]/ { print $1 }')

if [ "${#DRIVES[@]}" -eq 0 ]; then
    poweroff_now "No non-USB hard drive was detected on this machine. Installation cannot proceed."
fi

if [ "${#DRIVES[@]}" -gt 1 ]; then
    LIST=""
    for d in "${DRIVES[@]}"; do
        LIST+="  - /dev/$d"$'\n'
    done
    poweroff_now "More than one non-USB disk was detected:
$LIST
The appliance installer refuses to choose between them. Remove the extra drive(s) and try again."
fi

DEVICE="/dev/${DRIVES[0]}"
SIZE_BYTES=$(lsblk -d -n -b -o SIZE "$DEVICE")
SIZE_HUMAN=$(numfmt --to=iec --suffix=B "$SIZE_BYTES" 2>/dev/null || echo "${SIZE_BYTES} bytes")
MODEL=$(lsblk -d -n -o MODEL "$DEVICE" | sed -e 's/[[:space:]]\+/ /g' -e 's/^ //' -e 's/ $//')
[ -z "$MODEL" ] && MODEL="(unknown)"

echo "Target disk: $DEVICE ($SIZE_HUMAN, $MODEL)"

if [ ! -f "$IMAGE" ]; then
    poweroff_now "The appliance image was not found: $IMAGE. Installation cannot proceed."
fi

TOTAL=$(xz --robot --list "$IMAGE" 2>/dev/null | awk '/^totals/ {print $5}')
TOTAL=${TOTAL:-0}

if [ "$TOTAL" -le 0 ]; then
    poweroff_now "Could not determine the uncompressed size of $IMAGE. The file may be corrupt or not a valid xz archive."
fi

if [ "$TOTAL" -gt "$SIZE_BYTES" ]; then
    poweroff_now "The appliance image ($(numfmt --to=iec --suffix=B "$TOTAL")) is larger than the target disk ($SIZE_HUMAN). Installation cannot proceed."
fi

LOG=$(mktemp)

echo "Writing appliance image to $DEVICE (this may take several minutes)..."
xzcat "$IMAGE" | dd of="$DEVICE" bs=4M conv=fsync status=progress 2>"$LOG"
RESULT=$?
sync

cat "$LOG"

# Parse the authoritative byte count from dd's final stderr line.
DD_BYTES=$(awk '/copied/ { gsub(/[^0-9]/, "", $1); print $1; exit }' "$LOG")
DD_BYTES=${DD_BYTES:-0}

# Treat a short write as failure even if dd reported success
# (catches xzcat aborting on a corrupt archive).
if [ "$RESULT" -eq 0 ] && [ "$TOTAL" -gt 0 ] && [ "$DD_BYTES" -lt "$TOTAL" ]; then
    RESULT=2
fi

if [ "$RESULT" -eq 0 ]; then
    poweroff_now "The Nimbus appliance OS was written to $DEVICE successfully ($(numfmt --to=iec --suffix=B "$DD_BYTES") written). Installation is complete. Powering off."
else
    DD_ERR=$(tail -c 1500 "$LOG" 2>/dev/null)
    poweroff_now "Installation FAILED (exit code $RESULT). Wrote $DD_BYTES of $TOTAL bytes.

Last output from dd:
$DD_ERR"
fi
