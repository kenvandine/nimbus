#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: sudo ./clear-ubuntu-uefi-entries.sh

Deletes UEFI boot entries whose label is exactly:
  - ubuntu
  - Ubuntu

Requires efibootmgr and root privileges.
EOF
  exit 0
fi

if [[ $EUID -ne 0 ]]; then
  echo "Error: run as root." >&2
  exit 1
fi

if ! command -v efibootmgr >/dev/null 2>&1; then
  echo "Error: efibootmgr is required." >&2
  exit 1
fi

entries=()
while IFS= read -r line; do
  if [[ $line =~ ^Boot([0-9A-Fa-f]{4})[\*\ ]+(.+)$ ]]; then
    num="${BASH_REMATCH[1]}"
    label="${BASH_REMATCH[2]}"
    if [[ "$label" == "ubuntu" || "$label" == "Ubuntu" ]]; then
      entries+=("$num:$label")
    fi
  fi
done < <(efibootmgr)

if [[ ${#entries[@]} -eq 0 ]]; then
  echo "No matching UEFI boot entries found."
  exit 0
fi

echo "Deleting these UEFI boot entries:"
for entry in "${entries[@]}"; do
  echo "  Boot${entry%%:*} ${entry#*:}"
done

for entry in "${entries[@]}"; do
  num="${entry%%:*}"
  efibootmgr -b "$num" -B
done

echo
echo "Remaining matching entries:"
efibootmgr | grep -E '^Boot[0-9A-Fa-f]{4}[\*\ ]+(ubuntu|Ubuntu)$' || true
