#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="nimbus"
PROFILE_NAME="nimbus-hosting"

echo "==> Creating LXD profile: $PROFILE_NAME"
if lxc profile show "$PROFILE_NAME" &>/dev/null; then
  echo "    Profile already exists, skipping creation."
else
  lxc profile create "$PROFILE_NAME"
fi

lxc profile set "$PROFILE_NAME" security.nesting=true
lxc profile set "$PROFILE_NAME" security.syscalls.intercept.mknod=true
lxc profile set "$PROFILE_NAME" security.syscalls.intercept.setxattr=true

echo "==> Profile configured:"
lxc profile show "$PROFILE_NAME"

echo "==> Launching container: $CONTAINER_NAME"
if lxc info "$CONTAINER_NAME" &>/dev/null; then
  echo "    Container already exists, skipping launch."
else
  lxc launch ubuntu:24.04 "$CONTAINER_NAME" --profile default --profile "$PROFILE_NAME"
  echo "    Waiting for network..."
  sleep 5
fi

echo "==> Bootstrapping container dependencies"
lxc exec "$CONTAINER_NAME" -- bash -c "
  set -euo pipefail
  apt-get update -q
  apt-get install -y -q docker.io docker-compose-v2 python3 python3-venv git curl nodejs npm \
    debian-keyring debian-archive-keyring apt-transport-https

  # Install Caddy from official repo
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy

  systemctl enable --now docker

  # Create a venv for Nimbus (PEP 668 blocks system-wide pip on Ubuntu 24.04+)
  python3 -m venv /opt/nimbus-venv
  /opt/nimbus-venv/bin/pip install --quiet fastapi 'uvicorn[standard]' pyyaml psutil httpx aiofiles

  echo 'Bootstrap complete.'
"

echo "==> Creating Nimbus data directories"
lxc exec "$CONTAINER_NAME" -- bash -c "
  mkdir -p /var/lib/nimbus/store
  mkdir -p /var/lib/nimbus/installed
  mkdir -p /var/lib/nimbus/data/storage
  chmod 777 /var/lib/nimbus/data/storage
  mkdir -p /opt/nimbus
"

echo "==> Installing systemd services and Caddy config"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
lxc file push "$SCRIPT_DIR/nimbus.service" "$CONTAINER_NAME/etc/systemd/system/nimbus.service"
lxc file push "$SCRIPT_DIR/Caddyfile" "$CONTAINER_NAME/etc/caddy/Caddyfile"
lxc exec "$CONTAINER_NAME" -- systemctl daemon-reload
lxc exec "$CONTAINER_NAME" -- systemctl enable nimbus caddy
echo "    Services installed and enabled (will start after deploy)"

CONTAINER_IP=$(lxc info "$CONTAINER_NAME" | grep -oP '(?<=eth0:\s{10}inet\s)\S+' | head -1 || true)
if [ -z "$CONTAINER_IP" ]; then
  CONTAINER_IP=$(lxc list "$CONTAINER_NAME" --format csv -c 4 | cut -d' ' -f1)
fi

echo ""
echo "==> Setup complete!"
echo "    Container: $CONTAINER_NAME"
echo "    IP: ${CONTAINER_IP:-<check with: lxc list>}"
echo ""
echo "Next steps:"
echo "  1. From the repo root, run the deploy script:"
echo "       ./setup/deploy.sh"
echo "  2. Open http://${CONTAINER_IP:-<lxc list>}:8000 in your browser."
echo ""
echo "  To redeploy after code changes, just re-run: ./setup/deploy.sh"
echo "  To view logs: lxc exec $CONTAINER_NAME -- journalctl -u nimbus -f"
