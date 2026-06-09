#!/bin/bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${SCRIPT_DIR}/pc.img.xz"

if ! command -v whiptail >/dev/null 2>&1; then
    echo "Error: whiptail is required but not installed." >&2
    sleep 30
    exit 1
fi

if [ -z "${NEWT_COLORS:-}" ]; then
    export NEWT_COLORS='
root=white,black
window=white,black
border=brown,black
title=white,black
textbox=white,black
button=black,lightgray
actbutton=white,brown
compactbutton=white,black
actlistbox=black,lightgray
sellistbox=white,black
actsellistbox=white,brown
entry=white,black
checkbox=white,black
actcheckbox=black,lightgray
emptyscale=white,black
fullscale=white,brown
'
fi

poweroff_countdown() {
    local title="$1"
    local message="$2"
    local seconds
    local label

    for ((seconds=10; seconds>0; seconds--)); do
        if [ "$seconds" -eq 1 ]; then
            label="second"
        else
            label="seconds"
        fi

        whiptail --title "$title" --infobox \
"$message

The system will power off in $seconds $label." 20 72
        sleep 1
    done

    exec /sbin/poweroff
}

if command -v efibootmgr >/dev/null 2>&1; then
    bash "${SCRIPT_DIR}/clear-ubuntu-uefi-entries.sh" || true
fi

whiptail --title "Nimbus Appliance Installer" --msgbox \
"This installer will write the Nimbus appliance OS image to the internal \
disk of this machine.

All existing data on the target disk will be ERASED.

You will be asked to confirm before any data is written." 14 72

mapfile -t DRIVES < <(lsblk -d -n -o NAME,TYPE,TRAN \
    | awk '$2 == "disk" && $3 != "usb" && $1 !~ /^fd[0-9]/ { print $1 }')

if [ "${#DRIVES[@]}" -eq 0 ]; then
    poweroff_countdown "No Disk Found" \
"No non-USB hard drive was detected on this machine.

Installation cannot proceed."
fi

if [ "${#DRIVES[@]}" -gt 1 ]; then
    LIST=""
    for d in "${DRIVES[@]}"; do
        LIST+="  - /dev/$d"$'\n'
    done
    poweroff_countdown "Multiple Disks Found" \
"More than one non-USB disk was detected:

$LIST
The appliance installer refuses to choose between them. Remove \
the extra drive(s) and try again."
fi

DEVICE="/dev/${DRIVES[0]}"
SIZE_BYTES=$(lsblk -d -n -b -o SIZE "$DEVICE")
SIZE_HUMAN=$(numfmt --to=iec --suffix=B "$SIZE_BYTES" 2>/dev/null || echo "${SIZE_BYTES} bytes")
MODEL=$(lsblk -d -n -o MODEL "$DEVICE" | sed -e 's/[[:space:]]\+/ /g' -e 's/^ //' -e 's/ $//')
[ -z "$MODEL" ] && MODEL="(unknown)"

if ! whiptail --title "Confirm Disk Erasure" --defaultno --yesno \
"The following disk will be COMPLETELY ERASED and overwritten with the \
Nimbus appliance OS image:

  Device: $DEVICE
  Size:   $SIZE_HUMAN
  Model:  $MODEL

This operation cannot be undone. Continue?" 16 72; then
    poweroff_countdown "Cancelled" \
"Installation cancelled. No changes were made to $DEVICE."
fi

if [ ! -f "$IMAGE" ]; then
    poweroff_countdown "Missing Image" \
"The appliance image was not found:

  $IMAGE

Installation cannot proceed."
fi

TOTAL=$(xz --robot --list "$IMAGE" 2>/dev/null | awk '/^totals/ {print $5}')
TOTAL=${TOTAL:-0}

if [ "$TOTAL" -le 0 ]; then
    poweroff_countdown "Bad Image" \
"Could not determine the uncompressed size of $IMAGE. The file may be \
corrupt or not a valid xz archive."
fi

if [ "$TOTAL" -gt "$SIZE_BYTES" ]; then
    poweroff_countdown "Disk Too Small" \
"The appliance image is larger than the target disk:

  Image (uncompressed): $(numfmt --to=iec --suffix=B "$TOTAL")
  Disk:                 $SIZE_HUMAN

Installation cannot proceed."
fi

LOG=$(mktemp)
WRITTEN_FILE=$(mktemp)
echo 0 > "$WRITTEN_FILE"

xzcat "$IMAGE" | dd of="$DEVICE" bs=4M conv=fsync 2>"$LOG" &
DD_PID=$!

(
    while kill -0 "$DD_PID" 2>/dev/null; do
        if [ -r "/proc/$DD_PID/io" ]; then
            WRITTEN=$(awk '/^write_bytes:/ {print $2}' "/proc/$DD_PID/io" 2>/dev/null)
            WRITTEN=${WRITTEN:-0}
            echo "$WRITTEN" > "$WRITTEN_FILE"
            if [ "$TOTAL" -gt 0 ]; then
                PERCENT=$(( WRITTEN * 100 / TOTAL ))
                [ "$PERCENT" -gt 100 ] && PERCENT=100
                echo "$PERCENT"
            fi
        fi
        sleep 1
    done
    echo 100
) | whiptail --title "Installing" --gauge \
"Writing appliance image to $DEVICE...

(this may take several minutes)" 10 70 0

wait "$DD_PID"
RESULT=$?
sync

rm -f "$WRITTEN_FILE"

# Parse the authoritative byte count from dd's final stderr line --
# our /proc/io polling lags behind by up to the loop sleep interval.
DD_BYTES=$(awk '/copied/ { gsub(/[^0-9]/, "", $1); print $1; exit }' "$LOG")
DD_BYTES=${DD_BYTES:-0}

# Treat a short write as failure even if dd reported success
# (catches xzcat aborting on a corrupt archive).
if [ "$RESULT" -eq 0 ] && [ "$TOTAL" -gt 0 ] && [ "$DD_BYTES" -lt "$TOTAL" ]; then
    RESULT=2
fi

if [ "$RESULT" -eq 0 ]; then
    poweroff_countdown "Installation Complete" \
"The Nimbus appliance OS was written to $DEVICE successfully.

  Bytes written: $(numfmt --to=iec --suffix=B "$DD_BYTES")

Installation is complete. You can now remove the installation media."
else
    DD_ERR=$(tail -c 1500 "$LOG" 2>/dev/null)
    poweroff_countdown "Installation Failed" \
"Installation FAILED (exit code $RESULT).

  Wrote $DD_BYTES of $TOTAL bytes.

Last output from dd:
$DD_ERR"
fi
