# Nimbus

A self-hosted personal app store for managing apps from the [Umbrel app catalog](https://github.com/getumbrel/umbrel-apps). Nimbus can still run in the original all-in-one LXD container, but it now also supports a host-controller model where the UI/API runs outside the container, manages LXD directly with `pylxd`, and bootstraps an in-container Nimbus agent.

![Nimbus UI](https://getumbrel.github.io/umbrel-apps-gallery/immich/1.jpg)

---

## Architecture

```
Host (Linux + LXD)
├── Nimbus controller (snap or service on host)
│   ├── Frontend + public API
│   ├── LXD control path via pylxd + LXD socket
│   ├── Host device management (snapd refresh, reboot, power off)
│   └── Container bootstrap + orchestration
└── nimbus (LXD container, security.nesting=true)
    ├── Nimbus agent (bootstrapped by host controller)
    ├── Docker Engine
    │   ├── <app-1> containers  (e.g. Immich)
    │   └── <app-2> containers  (e.g. File Browser)
    └── App data and compose projects
```

| Layer | Technology |
|---|---|
| Backend | Python 3.12 · FastAPI · uvicorn |
| Frontend | React 18 · Vite |
| Container runtime | Docker Engine + Compose v2 (inside LXD) |
| App catalog | [getumbrel/umbrel-apps](https://github.com/getumbrel/umbrel-apps) |

---

## Requirements

- Linux host with [LXD](https://canonical.com/lxd) installed and initialised (`lxd init`)
- Internet access from the host (to pull Docker images and app metadata)
- ~4 GB free disk space for the app catalog clone and container images
- `snapcraft` if you want to build the strict snap locally

---

## Deployment modes

### 1. Local mode (current default)

Nimbus runs fully inside the LXD container exactly as before:

- `NIMBUS_CONTROL_MODE=local`
- `NIMBUS_SERVE_FRONTEND=true`
- `NIMBUS_BIND_HOST=127.0.0.1`

### 2. Split mode (host controller + managed container)

This is the stepping stone toward a strictly confined snap on Ubuntu Core:

- **Host controller**: runs the UI/public API with `NIMBUS_CONTROL_MODE=lxd`
- **Transport**: uses `pylxd` against the local LXD socket instead of shelling out to `lxc`
- **Managed container**: a `nimbus` LXD container runs Docker and app workloads
- **Container agent**: Nimbus is pushed into the container and started in `NIMBUS_CONTROL_MODE=local`, but the host controller remains the primary control path
- **Bootstrap**: the host controller creates the nested-container profile, creates/starts the `nimbus` container, pushes the backend + service files, installs runtime packages, and starts the agent

Example host-controller environment:

```bash
NIMBUS_CONTROL_MODE=lxd
NIMBUS_SERVE_FRONTEND=true
NIMBUS_REFRESH_STORE_ON_STARTUP=true
NIMBUS_LXD_AUTO_BOOTSTRAP=true
LXD_DIR=/var/snap/lxd/common/lxd
NIMBUS_LXD_IMAGE_SERVER=https://cloud-images.ubuntu.com/releases
NIMBUS_LXD_IMAGE_ALIAS=24.04
NIMBUS_LXD_PUBLISH_HOST=0.0.0.0
```

Example in-container agent environment:

```bash
NIMBUS_CONTROL_MODE=local
NIMBUS_API_TOKEN=<shared-secret>
NIMBUS_SERVE_FRONTEND=false
NIMBUS_BIND_HOST=0.0.0.0
```

### Security note

Nimbus now prefers the **more secure design**: keep Nimbus on the host and use direct LXD socket/API operations from the snap (`lxd` interface) with tightly scoped exec/file operations. The in-container agent is bootstrapped as an internal service, but app lifecycle and Docker orchestration are driven by the host controller through LXD rather than a network-exposed control API.

## Strict snap packaging

This repository now includes a `snapcraft.yaml` for the host controller snap.

The snap:

- runs the Nimbus UI/API as a strict daemon
- plugs `lxd` for direct LXD socket access
- plugs `snapd-control` for host device management operations
- builds the React frontend into `backend/static`
- auto-bootstraps the managed `nimbus` container on first start
- publishes installed app ports from the managed container onto the host with LXD proxy devices
- can update the host `core24`, `snapd`, `lxd`, and Nimbus snaps and request host restart / power-off actions through snapd

Build locally with:

```bash
snapcraft
```

Install and connect the required interfaces:

```bash
sudo snap install --dangerous ./nimbus_*.snap
sudo snap connect nimbus:lxd lxd:lxd
sudo snap connect nimbus:snapd-control
```

The packaged daemon listens on port `8000` and defaults to:

```bash
NIMBUS_CONTROL_MODE=lxd
NIMBUS_LXD_AUTO_BOOTSTRAP=true
LXD_DIR=/var/snap/lxd/common/lxd
```

In controller mode:

- the Nimbus UI/API is served from the **host**
- Docker apps run **inside** the managed `nimbus` container
- published app URLs should use the **host LAN IP**, not the container bridge IP

## Quick start

### Option A: strict snap controller mode

Build and install the snap:

```bash
snapcraft
sudo snap install --dangerous ./nimbus_*.snap
sudo snap connect nimbus:lxd lxd:lxd
sudo snap connect nimbus:snapd-control
```

Then open:

```text
http://<host-ip>:8000
```

On first boot, Nimbus will create and prepare the managed `nimbus` LXD container automatically.

### Option B: local/container mode

Use the legacy helper scripts if you want Nimbus to run fully inside the LXD container:

#### 1. Bootstrap the LXD container

From the repo root:

```bash
./setup/lxd-setup.sh
```

This will:
- Create a `nimbus-hosting` LXD profile with `security.nesting=true` and the required syscall intercepts
- Launch an Ubuntu 24.04 LXD container named `nimbus`
- Install Docker, Python 3, Node.js, and all Python dependencies into a venv at `/opt/nimbus-venv`
- Create data directories and install the systemd service

#### 2. Deploy the application

```bash
./setup/deploy.sh
```

This pushes the backend and frontend into the container, builds the React app, and starts (or restarts) the Nimbus systemd service.

#### 3. Open the UI

```
http://<container-ip>:8000
```

Find the container IP with `lxc list nimbus`.

---

## Updating after code changes

```bash
./setup/deploy.sh
```

The deploy script always pushes the latest code, rebuilds the frontend, and restarts the service. Installed apps are not affected.

To override service settings, create `/etc/default/nimbus` inside the target environment and set variables such as:

```bash
NIMBUS_CONTROL_MODE=local
NIMBUS_BIND_HOST=127.0.0.1
NIMBUS_PORT=8000
NIMBUS_API_TOKEN=
NIMBUS_REMOTE_BASE_URL=
NIMBUS_REMOTE_TOKEN=
NIMBUS_SERVE_FRONTEND=true
NIMBUS_REFRESH_STORE_ON_STARTUP=true
```

Useful controller-mode environment variables:

```bash
NIMBUS_PRIMARY_INTERFACE=eth0
NIMBUS_LXD_CONTAINER_NAME=nimbus
NIMBUS_LXD_PROFILE_NAME=nimbus-hosting
NIMBUS_LXD_IMAGE_SERVER=https://cloud-images.ubuntu.com/releases
NIMBUS_LXD_IMAGE_PROTOCOL=simplestreams
NIMBUS_LXD_IMAGE_ALIAS=24.04
NIMBUS_LXD_PUBLISH_HOST=0.0.0.0
```

## How LXD bootstrap works

When Nimbus runs in `NIMBUS_CONTROL_MODE=lxd`, the host controller:

1. Ensures the `nimbus-hosting` LXD profile exists with nesting/syscall settings.
2. Creates the `nimbus` Ubuntu container if it does not already exist.
3. Starts the container and installs Docker, Compose, Python, and supporting packages.
4. Pushes the Nimbus backend and systemd unit into the container via the LXD file API.
5. Writes `/etc/default/nimbus` for the in-container agent and starts the `nimbus` systemd service.
6. Uses direct LXD exec/file operations to manage Docker apps inside the container.
7. Publishes installed app ports on the host with LXD proxy devices so apps are reachable from other machines on the network.

The in-container agent is bootstrapped as an internal service, but current app lifecycle operations in `lxd` mode are driven primarily by the host controller through `pylxd`.

## Startup and readiness states

In controller mode, Nimbus reports two different startup experiences:

- **Setting up**: first-time provisioning of the managed LXD container
- **Starting**: Nimbus is restarting and reconnecting to an already-bootstrapped container

Nimbus is considered fully ready when:

- the managed container exists
- the container is running
- the bootstrap marker is present
- `bootstrap_state` is `ready`

Until then, the UI will show a startup banner instead of normal app status.

---

## Project structure

```
nimbus/
├── setup/
│   ├── lxd-setup.sh        # One-time container bootstrap
│   ├── deploy.sh           # Push code + restart service
│   └── nimbus.service      # systemd unit (installed into container)
├── backend/
│   ├── auth.py             # API token helpers
│   ├── config.py           # Runtime settings and mode selection
│   ├── main.py             # FastAPI app, startup lifecycle
│   ├── models.py           # Pydantic models (AppMeta, AppDetail, SystemStats)
│   ├── routers/
│   │   ├── apps.py         # GET /api/apps, POST install/update/uninstall, icon endpoint
│   │   └── system.py       # GET /api/system/stats
│   └── services/
│       ├── control_plane.py # local/remote/lxd orchestration layer
│       ├── lxd.py          # pylxd container bootstrap and app management
│       ├── store.py        # Clone umbrel-apps repo, parse YAML metadata
│       ├── docker.py       # docker compose install/uninstall, port detection
│       ├── network.py      # Host IP detection for Open URLs
│       └── icons.py        # SVG icon generator (fallback when CDN unavailable)
├── frontend/
│   ├── src/
│   │   ├── App.jsx         # Root: animated gradient bg, tab nav, polling
│   │   ├── api.js          # fetch wrappers for the backend API
│   │   └── components/
│   │       ├── AppCard.jsx     # App card with Install / Open / Uninstall
│   │       ├── AppModal.jsx    # Full detail view: gallery, description, actions
│   │       ├── AppStore.jsx    # Browse tab with search
│   │       ├── Installed.jsx   # Installed tab
│   │       └── SystemStats.jsx # CPU / RAM / Disk gauges
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── snap/
│   └── local/nimbus-launch # Snap entrypoint for the controller daemon
├── snapcraft.yaml          # Strict snap definition
├── pyproject.toml          # Packaging metadata for the Snapcraft Python plugin
└── SPEC.md                 # Original product specification
```

---

## How apps are installed

When you click **Install** on an app:

1. The backend copies the app's `docker-compose.yml` from the cloned umbrel-apps catalog to `/var/lib/nimbus/installed/<app-id>/`.
2. The compose file is patched for standalone use:
   - The Umbrel-internal `app_proxy` sidecar service is removed
   - A host port mapping is injected (`<external-port>:<internal-port>`) so the app is reachable directly
   - Old Compose v1 container hostname references (e.g. `immich_postgres_1`) are rewritten to Compose v2 service names (`postgres`)
   - The obsolete `version:` key is dropped
3. An `.env` file is written with `APP_DATA_DIR`, `APP_SEED`, and `UMBREL_ROOT` set to sensible local paths
4. All bind-mount host directories are pre-created with open permissions so non-root container users can write to them
5. `docker compose up -d` is run as a background task; the UI polls every 5 seconds to update status

App data is stored under `/var/lib/nimbus/installed/<app-id>/data/`.  
Shared storage (e.g. for file manager apps) lives at `/var/lib/nimbus/data/storage`.

In `lxd` mode, Nimbus prepares the app bundle on the host, pushes it into the managed container, starts it with Docker Compose there, and exposes the app port on the host with an LXD proxy device.

## Updating apps

Nimbus now supports app updates through the UI and API:

- the UI shows **Update available** when the installed version differs from the catalog version
- `POST /api/apps/{id}/update` refreshes the bundle and runs `docker compose pull` / `up -d`
- install and update operations run in the background

---

## API reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/apps` | List all store apps with installed/running status |
| `GET` | `/api/apps/{id}` | Single app detail |
| `POST` | `/api/apps/{id}/install` | Install app (202, runs in background) |
| `POST` | `/api/apps/{id}/update` | Update app in place (202, runs in background) |
| `POST` | `/api/apps/{id}/uninstall` | Uninstall app and remove volumes |
| `GET` | `/api/apps/{id}/icon.svg` | Generated SVG icon (fallback) |
| `GET` | `/api/apps/installing/active` | List app IDs currently installing |
| `GET` | `/api/system/stats` | CPU, RAM, disk usage and installed app count |
| `POST` | `/api/system/restart` | Request a host restart through snapd |
| `POST` | `/api/system/poweroff` | Request a host power-off through snapd |
| `POST` | `/api/system/update` | Update supported host snaps (`core24`, `snapd`, `lxd`, Nimbus) |

---

## Logs and troubleshooting

```bash
# Live Nimbus logs in local/container mode
lxc exec nimbus -- journalctl -u nimbus -f

# Live Nimbus logs for the strict snap controller
sudo snap logs nimbus -f

# Container status from the controller
lxc info nimbus
lxc info nimbus --show-log

# Logs for a specific installed app
lxc exec nimbus -- docker compose -p <app-id> \
  -f /var/lib/nimbus/installed/<app-id>/docker-compose.yml logs -f

# Show app containers
lxc exec nimbus -- docker ps -a
```

If an app installs but is not reachable:

1. Check `sudo snap logs nimbus -n 200`
2. Check the managed container state with `lxc info nimbus`
3. Check app compose logs inside the container
4. Confirm you are using the **host LAN IP** for the app URL, not the LXD bridge/container IP

If an app is reachable only from the host, check:

- the LXD proxy device exists on the `nimbus` container
- host firewall rules allow the published TCP port
- `NIMBUS_LXD_PUBLISH_HOST` is set appropriately (default: `0.0.0.0`)

---

## Known limitations

- **App compatibility**: Apps that depend on Umbrel-specific infrastructure beyond `app_proxy` (custom networks, Umbrel API calls) may not work correctly.
- **HTTPS varies by mode**: the strict snap controller currently serves plain HTTP by default; the legacy local/container setup still includes Caddy-related files in `setup/`, but that is separate from the snap controller path.
- **Single user**: There is no authentication on the Nimbus UI itself — treat it as a local-network tool.
- **Remote mode is transitional**: `remote` control mode still exists in the code, but `lxd` mode is the primary supported host-controller path.
