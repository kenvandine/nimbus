# Nimbus

A self-hosted personal app store for managing apps from the [Umbrel app catalogue](https://github.com/getumbrel/umbrel-apps). Nimbus can still run in the original all-in-one LXD container, but it now also supports a host-controller model where the UI/API runs outside the container, manages LXD directly with `pylxd`, and bootstraps an in-container Nimbus agent.

![Nimbus UI](https://getumbrel.github.io/umbrel-apps-gallery/immich/1.jpg)

---

## Architecture

```
Host (Linux + LXD)
├── Nimbus controller (snap or service on host)
│   ├── Frontend + public API
│   ├── LXD control path via pylxd + LXD socket
│   ├── Future host-management features (snapd-control, reboot, other snaps)
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
| App catalogue | [getumbrel/umbrel-apps](https://github.com/getumbrel/umbrel-apps) |

---

## Requirements

- Linux host with [LXD](https://canonical.com/lxd) installed and initialised (`lxd init`)
- Internet access from the host (to pull Docker images and app metadata)
- ~4 GB free disk space for the app catalogue clone and container images

---

## Deployment modes

### 1. Local mode (current default)

Nimbus runs fully inside the LXD container exactly as before:

- `NIMBUS_CONTROL_MODE=local`
- `NIMBUS_SERVE_FRONTEND=true`
- `NIMBUS_BIND_HOST=127.0.0.1`

### 2. Split mode (host controller + in-container agent)

This is the stepping stone toward a strictly confined snap on Ubuntu Core:

- **Host controller**: runs the UI/public API with `NIMBUS_CONTROL_MODE=lxd`
- **Transport**: uses `pylxd` against the local LXD socket instead of shelling out to `lxc`
- **Container agent**: Nimbus is pushed into the container and started in `NIMBUS_CONTROL_MODE=local`
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
- plugs `snapd-control` for future appliance-management operations
- builds the React frontend into `backend/static`
- auto-bootstraps the managed `nimbus` container on first start

Build locally with:

```bash
snapcraft
```

The packaged daemon listens on port `8000` and defaults to:

```bash
NIMBUS_CONTROL_MODE=lxd
NIMBUS_LXD_AUTO_BOOTSTRAP=true
LXD_DIR=/var/snap/lxd/common/lxd
```

## Quick start

### 1. Bootstrap the LXD container

From the repo root:

```bash
./setup/lxd-setup.sh
```

This will:
- Create a `nimbus-hosting` LXD profile with `security.nesting=true` and the required syscall intercepts
- Launch an Ubuntu 24.04 LXD container named `nimbus`
- Install Docker, Python 3, Node.js, and all Python dependencies into a venv at `/opt/nimbus-venv`
- Create data directories and install the systemd service

### 2. Deploy the application

```bash
./setup/deploy.sh
```

This pushes the backend and frontend into the container, builds the React app, and starts (or restarts) the Nimbus systemd service.

### 3. Open the UI

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

## How LXD bootstrap works

When Nimbus runs in `NIMBUS_CONTROL_MODE=lxd`, the host controller:

1. Ensures the `nimbus-hosting` LXD profile exists with nesting/syscall settings.
2. Creates the `nimbus` Ubuntu container if it does not already exist.
3. Starts the container and installs Docker, Compose, Python, and supporting packages.
4. Pushes the Nimbus backend and systemd unit into the container via the LXD file API.
5. Writes `/etc/default/nimbus` for the in-container agent and starts the `nimbus` systemd service.
6. Uses direct LXD exec/file operations to manage Docker apps inside the container.
7. Publishes installed app ports on the host with LXD proxy devices so apps are reachable from other machines on the network.

---

## Project structure

```
nimbus/
├── setup/
│   ├── lxd-setup.sh        # One-time container bootstrap
│   ├── deploy.sh           # Push code + restart service
│   └── nimbus.service      # systemd unit (installed into container)
├── backend/
│   ├── main.py             # FastAPI app, startup lifecycle
│   ├── models.py           # Pydantic models (AppMeta, AppDetail, SystemStats)
│   ├── routers/
│   │   ├── apps.py         # GET /api/apps, POST install/uninstall, icon endpoint
│   │   └── system.py       # GET /api/system/stats
│   └── services/
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
└── SPEC.md                 # Original product specification
```

---

## How apps are installed

When you click **Install** on an app in local mode:

1. The backend copies the app's `docker-compose.yml` from the cloned umbrel-apps catalogue to `/var/lib/nimbus/installed/<app-id>/`.
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

In split mode, the public API keeps the same contract but forwards app-management actions to the in-container agent.

---

## API reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/apps` | List all store apps with installed/running status |
| `GET` | `/api/apps/{id}` | Single app detail |
| `POST` | `/api/apps/{id}/install` | Install app (202, runs in background) |
| `POST` | `/api/apps/{id}/uninstall` | Uninstall app and remove volumes |
| `GET` | `/api/apps/{id}/icon.svg` | Generated SVG icon (fallback) |
| `GET` | `/api/apps/installing/active` | List app IDs currently installing |
| `GET` | `/api/system/stats` | CPU, RAM, disk usage and installed app count |

---

## Logs

```bash
# Live Nimbus service logs
lxc exec nimbus -- journalctl -u nimbus -f

# Logs for a specific installed app
lxc exec nimbus -- docker compose -p <app-id> \
  -f /var/lib/nimbus/installed/<app-id>/docker-compose.yml logs -f
```

---

## Known limitations

- **App compatibility**: Apps that depend on Umbrel-specific infrastructure beyond `app_proxy` (custom networks, Umbrel API calls) may not work correctly.
- **No HTTPS**: The UI and apps are served over plain HTTP. For remote access, put a reverse proxy (nginx, Caddy) in front.
- **Single user**: There is no authentication on the Nimbus UI itself — treat it as a local-network tool.
- **App updates**: There is no one-click update flow yet; uninstall and reinstall to update an app.
