# Nimbus

A self-hosted personal app store that runs inside a privileged LXD container. Nimbus lets you browse, install, and manage apps from the [Umbrel app catalogue](https://github.com/getumbrel/umbrel-apps) as Docker containers — all from a clean web UI.

![Nimbus UI](https://getumbrel.github.io/umbrel-apps-gallery/immich/1.jpg)

---

## Architecture

```
Host (Linux + LXD)
└── nimbus (LXD container, security.nesting=true)
    ├── Docker Engine
    │   ├── <app-1> containers  (e.g. Immich)
    │   └── <app-2> containers  (e.g. File Browser)
    └── Nimbus backend + frontend (uvicorn :8000)
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

When you click **Install** on an app:

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
