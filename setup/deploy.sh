#!/usr/bin/env bash
# Deploy or update Nimbus into the LXD container.
# Run from the repo root: ./setup/deploy.sh
set -euo pipefail

CONTAINER_NAME="nimbus"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Pushing app files to container"
lxc exec "$CONTAINER_NAME" -- mkdir -p /opt/nimbus
lxc file push -r "$REPO_ROOT/backend/"  "$CONTAINER_NAME/opt/nimbus/"
lxc file push -r "$REPO_ROOT/frontend/" "$CONTAINER_NAME/opt/nimbus/"

echo "==> Building frontend"
lxc exec "$CONTAINER_NAME" -- bash -c "
  set -euo pipefail
  cd /opt/nimbus/frontend
  npm install --silent
  npm run build
"

echo "==> Reloading and restarting Nimbus service"
lxc exec "$CONTAINER_NAME" -- bash -c "
  systemctl daemon-reload
  systemctl enable nimbus
  systemctl restart nimbus
"

CONTAINER_IP=$(lxc list "$CONTAINER_NAME" --format csv -c 4 | awk '{print $1}' | head -1)
echo ""
echo "==> Deploy complete! Open http://${CONTAINER_IP:-<lxc list>}:8000"
