#!/usr/bin/env bash
# Install and enable nimbus.local mDNS advertisement on the host.
# Run this once on the host (not inside the container).
set -euo pipefail

if ! command -v avahi-publish &>/dev/null; then
  echo "Installing avahi-utils..."
  sudo apt-get install -y avahi-utils
fi

echo "Installing nimbus-mdns.service..."
sudo cp "$(dirname "$0")/nimbus-mdns.service" /etc/systemd/system/nimbus-mdns.service
sudo systemctl daemon-reload
sudo systemctl enable --now nimbus-mdns.service

echo "Done — nimbus.local should resolve to $(lxc exec nimbus -- ip -4 addr show eth0 | grep -oP '(?<=inet )[^/]+')"
