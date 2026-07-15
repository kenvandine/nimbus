# Nimbus

A self-hosted appliance platform for managing AI agents and apps. Nimbus features a curated selection of agents and apps optimized for the appliance experience, sourced from the [Snap Store](https://snapcraft.io). It runs on the host as a strict snap, manages an LXD container for all app workloads, and exposes a full-featured web UI with authentication, a terminal, file browser, Wi-Fi configuration, firewall, SSH key management, container snapshots, and an AI chat assistant (OpenClaw).

---

## Architecture

```
                              ┌──────────────────────────────────────────────────────┐
                              │  Nimbus App Store                                    │
                              │  github.com/kenvandine/nimbus-app-store              │
                              │  catalog.json  ·  classic snap index                 │
                              └─────────────────────┬────────────────────────────────┘
                                                    │ HTTPS
  ┌─────────────────────────────────────────────────┼──────────────────────────────────────────────┐
  │  Ubuntu Core 24  ·  snapd  ·  pc-kernel  ·  core24  ·  pc-gadget                               │
  │                                                 │                                              │
  │  ┌──────────────────────────────────────────────┼────────────────────────────────────────────┐ │
  │  │  nimbus  (snap)  ·  :443 HTTPS + WSS         │                                            │ │
  │  │                                              ▼                                            │ │
  │  │  ┌──────────────────────┐  REST/SSE  ┌──────────────────────────────────────────────┐     │ │
  │  │  │      Frontend        │◄──────────►│  Backend  (FastAPI)                          │     │ │
  │  │  │     React / Vite     │            │  /apps · /models · /terminal · /ssh          │     │ │
  │  │  └──────────────────────┘            │  /network · /snapshots · /firewall · /files  │     │ │
  │  │           ▲                          └──────┬───────────────────────────┬───────────┘     │ │
  │  └───────────┼────────────────── pylxd / :9001─┴───────────────── :13305───┴─────────────────┘ │
  │              │ :443                            │                           │                   │
  │  ┌───────────┴──────────────────────┐          │                           │                   │
  │  │  Kiosk Stack                     │          │                           │                   │
  │  │  ubuntu-frame (Wayland display)  │          │                           │                   │
  │  │  chromium  ·  mesa-2404          │          │                           │                   │
  │  │  gnome-46-2404                   │          │                           │                   │
  │  └──────────────────────────────────┘          │                           │                   │
  │  ┌──────────────────────────────────┐          │                           │                   │
  │  │  network-manager                 │          │                           │                   │
  │  │  tailscale  (VPN)                │          │                           │                   │
  │  └──────────────────────────────────┘          │                           │                   │
  │                                                │                           │                   │
  │  ┌─────────────────────────────────────────────▼──────────┐  ┌─────────────▼─────────────┐     │
  │  │  lxd  (snap)                                           │  │  lemonade-server  (snap)  │     │
  │  │                                                        │  │                           │     │
  │  │  ┌────────────────────────────────────────────────┐    │  │  Qwen3.5-9B               │     │
  │  │  │  nimbus-container  (LXC)                       │    │  │  Qwen3-35B-A3B            │     │
  │  │  │                                                │    │  │  OpenAI-compatible        │     │
  │  │  │  ┌──────────────────────────────────────────┐  │    │  │  :13305                   │     │
  │  │  │  │  openclaw  (snap)  ·  AI agent           ├──┼────┼─►│                           │     │
  │  │  │  └──────────────────────────────────────────┘  │    │  └───────────────────────────┘     │
  │  │  │  ┌──────────────────────────────────────────┐  │    │                                    │
  │  │  │  │  app snaps  (classic)                    │  │    │                                    │
  │  │  │  └──────────────────────────────────────────┘  │    │                                    │
  │  │  │  ┌──────────────────────────────────────────┐  │    │                                    │
  │  │  │  │  nimbus-lxc-agent  :9001  ◄── backend    │  │    │                                    │
  │  │  │  └──────────────────────────────────────────┘  │    │                                    │
  │  │  └────────────────────────────────────────────────┘    │                                    │
  │  └────────────────────────────────────────────────────────┘                                    │
  │                                                                                                │
  │  also: remote Browser  ──── HTTPS :443 ──────────────────────────────────────► nimbus          │
  └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Layer | Technology |
|---|---|
| OS | Ubuntu Core 24 · snapd · pc-kernel · core24 |
| Kiosk display | ubuntu-frame (Wayland) · chromium · mesa-2404 · gnome-46-2404 |
| Networking | network-manager · tailscale |
| Backend | Python 3.12 · FastAPI · uvicorn |
| Frontend | React 18 · Vite |
| Container runtime | LXD + classic snap apps (inside LXD container) |
| Local AI | lemonade-server snap · Qwen3.5-9B / Qwen3-35B-A3B · OpenAI-compatible :13305 |
| App catalog | AI Labs snap catalog (default) · Docker/Umbrel catalog (deprecated) |
| TLS | Self-signed (auto) or ACME DNS-01 via Let's Encrypt |

---

## Requirements

- Linux host with [LXD](https://canonical.com/lxd) installed and initialised (`lxd init`)
- Internet access from the host (to pull app metadata and snap packages)
- ~4 GB free disk space for the app catalog and container images
- `snapcraft` if you want to build the snap locally

---

## Quick start

### Snap install (recommended)

Build and install the snap:

```bash
snapcraft
sudo snap install --dangerous ./nimbus_*.snap
sudo snap connect nimbus:lxd lxd:lxd
```

Then open `https://<host-ip>` in a browser. On first boot:

1. Nimbus creates and bootstraps the managed `nimbus` LXD container automatically.
2. An out-of-box experience (OOBE) guides you through initial account creation.
3. The OpenClaw AI assistant and any preseed apps are installed automatically.

> **TLS**: the snap defaults to HTTPS on port 443. A self-signed certificate is
> generated automatically on first start. See [TLS / HTTPS](#tls--https) to
> configure Let's Encrypt.

### Headless Wi-Fi Onboarding & Network Handover

If the appliance has a Wi-Fi adapter but no ethernet cable connected on first boot, it automatically starts a Wi-Fi Access Point (hotspot) with the SSID `nimbus` (no password required) and starts a captive portal DNS server on port 5300.

1. Connect your phone or computer to the **`nimbus`** Wi-Fi network.
2. A **captive portal notification** will pop up on your device (e.g. "Sign in to network"). Click it to open the onboarding wizard. If the notification does not appear, open a browser and go to `http://10.42.0.1`.
3. Select your local Wi-Fi network and enter its credentials.
4. The appliance will connect to your local Wi-Fi, disable the onboarding hotspot, and allow you to complete the OOBE setup.

#### Under the Hood: Network Transition & LXC Restart
To ensure a smooth transition from the temporary onboarding hotspot to the target client network:
* **Dynamic LXC Restart:** Since the first boot with the Wi-Fi AP lacks a real WAN/Internet connection, the LXD container is automatically restarted once the host transitions to the client network to prevent DNS resolution race conditions and ensure the container's network connection is fully established.
* **NetworkManager D-Bus Bridge Unmanagement:** To prevent NetworkManager on the host from attempting to manage or capture the LXD bridge interface (`lxdbr0`) and causing DNS routing failures, Nimbus uses a dynamic D-Bus unmanagement mechanism. It registers the bridge interface as unmanaged on the fly via D-Bus, ensuring robust container-to-host DNS and internet routing.


### Tailscale VPN

The appliance ships with the `tailscale` snap pre-installed. The Nimbus Settings panel includes a **Tailscale** section that shows connection status and provides in-UI access to the Tailscale web client.

#### How it works

Three systemd services are injected into the Ubuntu Core image by `model/build.sh`:

- **`tailscale-web.service`** — runs `tailscale web --listen=127.0.0.1:8088` (the Tailscale legacy web server, bound to loopback). The Nimbus backend reverse-proxies this at `/api/tailscale/webclient/` so the full management UI is reachable over HTTPS from any browser without extra port exposure.
- **`tailscale-auth-bridge.service`** — a minimal Python HTTP server on `localhost:8089` that intercepts `GET /api/auth/session/new` — the one auth endpoint that `tailscale web` refuses from non-tailscale sources. It reads the auth URL directly from the tailscale daemon socket and returns `{"authUrl": "..."}` in the format the web client JS expects. This service runs as root (outside snap confinement), which is why the intercept cannot be done from within the Nimbus snap itself.
- **`nimbus-connect.service`** — also calls `tailscale set --webclient` so that once the device joins a tailnet, peer devices can reach the management UI directly at `<tailscale-ip>:5252`.

Status detection reads the `tailscale0` interface via psutil — no additional snap permissions are required.

#### Why `nimbus.local:5252` doesn't work

`tailscale set --webclient` tells `tailscaled` to serve on port 5252 **bound to the Tailscale virtual interface** (`100.x.x.x`) only. `nimbus.local` resolves to the LAN IP via mDNS — there is no listener on that interface. Use `https://nimbus.local/api/tailscale/webclient/` (through the Nimbus proxy) instead, which works both before and after joining a tailnet.

#### Joining the tailnet

SSH in (or use the built-in Terminal panel) and run:

```bash
tailscale up
```

Copy the auth URL that appears and visit it in a browser to link the device to your tailnet. After authentication, the Settings panel will show the assigned Tailscale IP and offer a direct link to the peer-accessible web client at `<tailscale-ip>:5252`.

#### Design notes (store-publishable)

The integration deliberately avoids:
- The `system-files` interface (not auto-connectable in the Snap Store for arbitrary paths)
- The `tailscale:socket` content interface (requires a runtime `snap connect` and a snap restart to take effect for the running daemon)

The reverse-proxy approach uses only the existing `network` plug, which allows loopback TCP connections to the `tailscale web` process without any additional assertions.

---

### Local / container mode (development)

Use the helper scripts if you want Nimbus to run fully inside the LXD container:

```bash
# 1. Create and configure the LXD container
./setup/lxd-setup.sh

# (Optional) Configure mDNS so nimbus.local resolves on the host
./setup/setup-mdns.sh

# 2. Push code + build frontend + restart service
./setup/deploy.sh
```

Then open `http://<container-ip>:8000`. Find the container IP with `lxc list nimbus`.

---

## Snap settings

All settings are applied with `snap set nimbus <key>=<value>`. The configure
hook validates the value and restarts the daemon immediately.

| Setting | Values / default | Description |
|---|---|---|
| `model-provider` | `lemonade-server` (default) · `inference-snap-gemma4` | Local-LLM backend OpenClaw is configured against. |
| `openai-url` | URL (unset → per-provider default) | Override the OpenAI-compatible API URL. Must include `/v1` or `/api/v1`. |
| `appstore-visible` | `false` (default) · `true` | Show or hide the App Store tab in the UI. |
| `preseed-apps` | Comma-separated app IDs (empty) | Extra app IDs to auto-install on first boot. `openclaw` is always preseeded when the store is hidden. |
| `appstore-whitelist` | Comma-separated app IDs | Override the default allow-list of apps shown in the store. |
| `app-store-type` | `nimbus` (default) · `umbrel` *(deprecated)* | App catalog backend. See [App store backend](#app-store-backend). |
| `provisioning-url` | HTTPS URL (unset) | ACME provisioning backend for Let's Encrypt TLS certificates. |
| `provisioning-token` | String (unset) | Authentication token for the provisioning backend. |

### Model provider

```bash
# Default — uses the lemonade-server snap (port 13305)
sudo snap set nimbus model-provider=lemonade-server

# Alternative — uses the gemma4 inference snap (port 8336)
sudo snap set nimbus model-provider=inference-snap-gemma4
```

The selected provider must be preseeded in the Ubuntu Core model assertion — Nimbus does not install snaps on demand. OpenClaw is wired to the provider via environment variables (`NIMBUS_OPENCLAW_BASE_URL`, `NIMBUS_OPENCLAW_MODEL_ID`, etc.) consumed by `openclaw-overlay/setup-wrapper.cjs`.

### OpenAI-compatible endpoint

Override the URL for the model backend (useful for non-standard ports or remote endpoints):

```bash
sudo snap set nimbus openai-url=http://127.0.0.1:8336/v1
```

Clear with `snap unset nimbus openai-url` to revert to the per-provider default.

Per-provider defaults:
- `lemonade-server` → `http://127.0.0.1:13305/api/v1`
- `inference-snap-gemma4` → `http://127.0.0.1:8336/v1`

### Cloud offload (lemonade-server only)

Nimbus can route *some* chat requests to an OpenAI-compatible cloud provider (Fireworks, OpenAI, OpenRouter, Together, or any custom endpoint) while keeping the local model as the default, using [lemonade's cloud offload](https://lemonade-server.ai) and `collection.router` policy engine. Configured entirely from the web UI — **Device Info → Cloud Offload**:

1. **Add a provider** — pick a curated preset (base URL pre-filled) or enter a custom name + base URL, plus the provider's API key. The key is stored encrypted at rest in `$SNAP_DATA/cloud-providers.json` (same Fernet scheme as the API-key store) and re-applied to lemonade at every Nimbus start, since lemonade holds runtime keys in process memory only.
2. **Pick a cloud model** — discovered live from the provider through lemonade (`fireworks.kimi-k2p5`-style namespaced names).
3. **Choose offload rules** — plain-language toggles: offload requests that use tools, requests with images, requests matching keywords, or inputs longer than N characters. An **Advanced: edit policy JSON** escape hatch accepts a raw lemonade routing block (`candidates` / `default_model` / `rules`) for anything the toggles can't express.

How it works: Nimbus always maintains one lemonade `collection.router` model named **`user.NimbusModel`** and points every claw app (OpenClaw, hermes-agent, AnythingLLM, PicoClaw, …) at that fixed name permanently. Switching the active local model or toggling cloud offload only rewrites the collection's definition inside lemonade — no app is ever reconfigured, and requests that match no offload rule (or hit any error) always fall through to the local model. Policy state lives in `$SNAP_COMMON/model_router.json` (no secrets).

### App store visibility

The App Store tab is hidden by default on appliance images (only the curated agent whitelist is shown). Enable it to let users browse and install from the full catalog:

```bash
sudo snap set nimbus appstore-visible=true
```

When the store is hidden, `openclaw` is always auto-installed on first boot. When it is visible, users install apps themselves.

### Preseed apps

Extra app IDs to auto-install on first boot (comma-separated):

```bash
sudo snap set nimbus preseed-apps=nextcloud,home-assistant
```

Apps in this list are installed once; removing an ID does not uninstall the app.

### App store whitelist

Override which apps are shown in the store (defaults to `openclaw,hermes-agent,picoclaw,immich`):

```bash
sudo snap set nimbus appstore-whitelist=openclaw,immich,nextcloud
```

### App store backend

```bash
# Default — hosted JSON catalog (github.com/kenvandine/nimbus-app-store)
sudo snap set nimbus app-store-type=nimbus

# Deprecated — clones the Umbrel git repo and installs apps via Docker Compose
sudo snap set nimbus app-store-type=umbrel
```

The default `nimbus` backend fetches a curated JSON catalog and installs apps as classic snaps inside the managed container. The `umbrel` backend is **deprecated**: it clones the Umbrel git app catalog on startup and installs apps via Docker Compose. It is retained for compatibility but is not used in the default configuration and will be removed in a future release.

### TLS / HTTPS

The snap serves HTTPS on port 443 by default. A self-signed certificate is
generated automatically on first start and stored in `$SNAP_COMMON/tls/`.

For a publicly-trusted certificate via Let's Encrypt (ACME DNS-01):

```bash
sudo snap set nimbus provisioning-url=https://api.nimbusappliance.app
sudo snap set nimbus provisioning-token=<your-token>
```

When `provisioning-url` is set, Nimbus registers the device with the
provisioning backend, obtains an assigned subdomain, and requests a certificate
via ACME DNS-01 on startup. The certificate is renewed automatically.

To use Let's Encrypt staging (testing only — certificates are not trusted):

```bash
NIMBUS_ACME_STAGING=1  # set in the snap environment or /etc/default/nimbus
```

---

## Factory reset

`nimbus.reset` wipes all installed app data and clears the preseed state so apps are reinstalled automatically on the next daemon start. The managed LXD container and its runtime are preserved.

```bash
sudo nimbus.reset
```

The command prompts for confirmation before doing anything destructive.

---

## Deployment modes

### lxd (default snap mode)

The host snap manages an LXD container. All app workloads run inside the container; the Nimbus UI and API run on the host.

```bash
NIMBUS_CONTROL_MODE=lxd
NIMBUS_LXD_AUTO_BOOTSTRAP=true
LXD_DIR=/var/snap/lxd/common/lxd
```

### local (in-container / development)

Nimbus runs fully inside the LXD container. Useful for development or the legacy deployment path.

```bash
NIMBUS_CONTROL_MODE=local
NIMBUS_SERVE_FRONTEND=true
NIMBUS_BIND_HOST=0.0.0.0
```

---

## Environment variables reference

All variables can be set in `/etc/default/nimbus` (inside the container for `local` mode) or via the snap environment. Snap settings (above) override these where both apply.

### Core

| Variable | Default | Description |
|---|---|---|
| `NIMBUS_CONTROL_MODE` | `local` | `local`, `lxd`, or `remote` |
| `NIMBUS_BIND_HOST` | `0.0.0.0` | Address uvicorn binds to |
| `NIMBUS_PORT` | `443` (snap) / `8000` (local) | Listen port |
| `NIMBUS_API_TOKEN` | — | Static bearer token for API auth (optional) |
| `NIMBUS_SERVE_FRONTEND` | `true` | Serve the React SPA from the backend |
| `NIMBUS_REFRESH_STORE_ON_STARTUP` | `true` (lxd/local) | Pull latest app catalog on start |

### TLS

| Variable | Default | Description |
|---|---|---|
| `NIMBUS_TLS` | `1` (snap) | Enable TLS (`1`/`true` or `0`/`false`) |
| `NIMBUS_HTTP_REDIRECT_PORT` | `80` | Port for the HTTP → HTTPS redirect listener |
| `NIMBUS_PROVISIONING_URL` | — | ACME provisioning backend URL |
| `NIMBUS_PROVISIONING_TOKEN` | — | Token for the provisioning backend |
| `NIMBUS_ACME_STAGING` | `0` | Use Let's Encrypt staging (`1` for testing) |

### LXD controller

| Variable | Default | Description |
|---|---|---|
| `NIMBUS_LXD_AUTO_BOOTSTRAP` | `true` (lxd) | Auto-create and bootstrap the managed container |
| `NIMBUS_LXD_CONTAINER_NAME` | `nimbus` | Name of the managed LXD container |
| `NIMBUS_LXD_PROFILE_NAME` | `nimbus-hosting` | LXD profile for the managed container |
| `NIMBUS_LXD_IMAGE_SERVER` | `https://cloud-images.ubuntu.com/releases` | Remote image server |
| `NIMBUS_LXD_IMAGE_PROTOCOL` | `simplestreams` | Image server protocol |
| `NIMBUS_LXD_IMAGE_ALIAS` | `24.04` | Remote image alias |
| `NIMBUS_LXD_LOCAL_IMAGE_ALIAS` | `nimbus-runtime` (snap) | Pre-seeded local image alias (skips download) |
| `NIMBUS_LXD_PUBLISH_HOST` | `0.0.0.0` | Host address for LXD proxy devices |
| `NIMBUS_LXD_AGENT_PORT` | `9001` | Port the in-container agent LXD proxy device listens on |
| `NIMBUS_PRIMARY_INTERFACE` | `eth0` | Network interface used to derive the host LAN IP |
| `LXD_DIR` | `/var/snap/lxd/common/lxd` | LXD state directory (snap default) |

### App catalog

| Variable | Default | Description |
|---|---|---|
| `NIMBUS_APP_STORE_TYPE` | `nimbus` | `nimbus` (hosted JSON catalog, snap install) or `umbrel` *(deprecated — Docker Compose, Umbrel git catalog)* |
| `NIMBUS_STORE_URL` | `https://raw.githubusercontent.com/kenvandine/nimbus-app-store/main/catalog.json` | URL of the Nimbus catalog JSON |
| `NIMBUS_STORE_DIR` | `/var/lib/nimbus/store` | Local clone/cache directory |
| `NIMBUS_INSTALLED_DIR` | `/var/lib/nimbus/installed` | Installed app bundle directory |
| `NIMBUS_APPSTORE_VISIBLE` | `false` | Show the full app store tab |
| `NIMBUS_APPSTORE_WHITELIST` | `openclaw,hermes-agent,picoclaw,immich` | Comma-separated visible app IDs |
| `NIMBUS_PRESEED_APPS` | — | Comma-separated app IDs to auto-install on first boot |

### AI / model provider

| Variable | Default | Description |
|---|---|---|
| `NIMBUS_MODEL_PROVIDER` | `lemonade-server` | `lemonade-server` or `inference-snap-gemma4` |
| `NIMBUS_OPENAI_URL` | Per-provider default | Full OpenAI-compatible API URL (including `/v1` suffix) |

### Misc

| Variable | Default | Description |
|---|---|---|
| `NIMBUS_FILES_ROOT` | `$HOME` (`$SNAP_COMMON` in snap) | Root directory exposed by the file browser |
| `NIMBUS_OVERLAY_DIR` | `$SNAP/share` (snap) | Directory for Nimbus-shipped overlay files |

---

## How LXD bootstrap works

When `NIMBUS_CONTROL_MODE=lxd`, the host controller:

1. Ensures the `nimbus-hosting` LXD profile exists with `security.nesting=true` and required syscall intercepts.
2. Imports the pre-seeded local image (`nimbus-runtime`) if present, otherwise downloads Ubuntu 24.04.
3. Creates and starts the `nimbus` LXD container.
4. Installs Docker, Compose, Python, and supporting packages (skipped if pre-installed in the seed image).
5. Pushes the Nimbus backend, systemd unit, and overlay files into the container via the LXD file API.
6. Installs Python dependencies inside the container.
7. Starts the `nimbus` systemd service (the in-container agent).
8. Sets up an LXD proxy device so the host controller can reach the in-container agent.
9. Publishes installed app ports on the host with LXD proxy devices.

The bootstrap is idempotent — each step is skipped if already complete.

## Startup and readiness states

In controller mode the UI shows a startup banner until the container is fully ready.

| State | First boot message | Subsequent boot message |
|---|---|---|
| `idle` | Preparing the managed environment. | Checking the managed container. |
| `waiting-for-network` | Waiting for network before setting up. | — |
| `ensuring-profile` | Configuring the LXD profile. | Checking container configuration. |
| `importing-image` | Importing pre-built container image. | Importing container image. |
| `ensuring-container` | Creating and starting the container. | Starting the managed container. |
| `installing-runtime` | Installing Docker and system packages. | — |
| `pushing-agent` | Copying Nimbus services into the container. | — |
| `installing-agent-python` | Installing Python dependencies. | — |
| `starting-agent` | Starting Nimbus services. | Starting managed services. |
| `ready` | Finalizing setup. | Finishing startup. |

Nimbus is considered fully ready when the container is running, the bootstrap marker is present, and `bootstrap_state == "ready"`.

---

## Project structure

```
nimbus/
├── setup/
│   ├── lxd-setup.sh            # One-time container bootstrap (local mode)
│   ├── deploy.sh               # Push code + restart service (local mode)
│   ├── setup-mdns.sh           # Configure host-name resolution for nimbus.local (local mode)
│   ├── Caddyfile               # Caddy reverse-proxy configuration
│   ├── nimbus-lxc-agent.service # systemd unit for the container-side agent
│   ├── nimbus-mdns.service     # Avahi mDNS advertisement systemd unit
│   ├── snap-catalog.json       # Local store application catalog definition
│   └── nimbus.service          # systemd unit (installed into container)
├── backend/
│   ├── auth.py                 # Session / bearer-token auth helpers
│   ├── config.py               # Runtime settings (all env vars)
│   ├── constants.py            # Centralized port and path constants
│   ├── main.py                 # FastAPI app, startup lifecycle
│   ├── models.py               # Pydantic models (AppDetail, SystemStats, …)
│   ├── agent/
│   │   └── daemon.py           # In-container nimbus-lxc-agent process
│   ├── routers/
│   │   ├── apps.py             # App install / update / uninstall / logs
│   │   ├── auth.py             # Login, logout, account creation
│   │   ├── files.py            # File browser (list / read / write)
│   │   ├── firewall.py         # ufw firewall management (LXD mode)
│   │   ├── keys.py             # Named API key store
│   │   ├── model_router.py     # Cloud offload providers + routing policy
│   │   ├── models.py           # Model pull / status / available / select
│   │   ├── network.py          # Network addresses, Wi-Fi, DNS
│   │   ├── openclaw.py         # OpenClaw AI assistant status
│   │   ├── snap_store.py       # AI-Labs snap catalog + container snap install
│   │   ├── snapshots.py        # LXD container snapshots (create / restore / delete)
│   │   ├── ssh.py              # SSH authorized-key management
│   │   ├── system.py           # Stats, restart, power-off, update, logs, resources
│   │   ├── tailscale.py        # Tailscale status + reverse-proxy for tailscale web UI
│   │   └── terminal.py         # WebSocket terminal (persistent LXD exec session)
│   └── services/
│       ├── api_keys.py         # Named key persistence
│       ├── auth.py             # JWT session tokens, bcrypt password hashing
│       ├── container_snaps.py  # snapd inside the LXD container
│       ├── control_base.py     # Base orchestration service class
│       ├── control_plane.py    # local / lxd orchestration layer
│       ├── crypto_store.py     # Shared Fernet-encrypted JSON store helpers
│       ├── device.py           # OOBE state, host info
│       ├── device_id.py        # Persistent per-device identifier
│       ├── docker.py           # docker compose install / uninstall / logs
│       ├── firewall.py         # ufw wrapper
│       ├── gemma4.py           # gemma4 snap status and port discovery
│       ├── icons.py            # SVG icon fallback generator
│       ├── lemonade.py         # lemonade-server status and model pull
│       ├── lxd.py              # pylxd bootstrap, app management, snapshots
│       ├── model_provider.py   # OpenClaw provider config (lemonade / gemma4)
│       ├── model_router.py     # Always-on lemonade collection.router + cloud offload
│       ├── network.py          # Host IP detection, DNS management
│       ├── nimbus_store.py     # Nimbus JSON catalog parser
│       ├── openclaw.py         # OpenClaw reachability and agent discovery
│       ├── provisioning.py     # TLS provisioning (self-signed or ACME DNS-01)
│       ├── snap_store.py       # AI-Labs snap catalog loader
│       ├── ssh.py              # authorized_keys management
│       ├── store.py            # Deprecated: Umbrel-format Docker Compose catalog parser
│       ├── system_apps.py      # System-app metadata (openclaw, hermes-agent)
│       ├── tailscale.py        # Tailscale connection status via psutil
│       ├── tls.py              # TLS certificate helpers
│       └── wifi.py             # NetworkManager Wi-Fi management
├── frontend/
│   ├── src/
│   │   ├── App.jsx             # Root: SSE stats, routing, setup state
│   │   ├── api.js              # fetch wrappers for the backend API
│   │   └── components/
│   │       ├── AppCard.jsx         # App card (Install / Open / Uninstall)
│   │       ├── AppLogViewer.jsx    # Streaming app log viewer
│   │       ├── AppModal.jsx        # Full app detail (gallery, actions, logs)
│   │       ├── AppStore.jsx        # Browse tab with search
│   │       ├── DeviceInfo.jsx      # Device info, snapshots, resource limits
│   │       ├── Dock.jsx            # Bottom dock navigation
│   │       ├── FileBrowser.jsx     # File browser panel
│   │       ├── FileEditor.jsx      # In-browser text editor
│   │       ├── HermesWidget.jsx    # Hermes agent widget
│   │       ├── Installed.jsx       # Installed apps tab
│   │       ├── KioskReadyScreen.jsx # Kiosk boot / setup progress screen
│   │       ├── Login.jsx           # Login screen
│   │       ├── Oobe.jsx            # Out-of-box experience wizard
│   │       ├── OpenClawWidget.jsx  # OpenClaw AI chat widget
│   │       ├── ScreenLock.jsx      # Inactivity screen lock
│   │       ├── Settings.jsx        # Settings panel (network, SSH, firewall, …)
│   │       ├── SystemLogViewer.jsx # Host + container log streaming
│   │       ├── SystemStats.jsx     # CPU / RAM / Disk gauges
│   │       ├── TerminalPanel.jsx   # In-browser terminal (WebSocket)
│   │       └── Window.jsx          # Floating window chrome
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── model/
│   ├── build.sh                # Build Ubuntu Core model assertions and ISOs
│   ├── nimbus-lemonade.json    # Model definition (lemonade-server LLM backend)
│   └── nimbus-gemma4.json      # Model definition (gemma4 inference snap backend)
├── snap/
│   ├── hooks/configure         # Validate and apply snap settings; restart daemon
│   └── local/
│       ├── nimbus-launch       # Snap daemon entrypoint (reads snap settings, starts uvicorn)
│       ├── nimbus-reset        # Snap reset command entrypoint
│       └── nimbus_reset.py     # Factory-reset logic (stop apps, wipe data)
├── openclaw-overlay/           # OpenClaw setup-wrapper and config assets
├── lxc-seed/                   # Pre-built LXC image tarball (bundled into snap)
├── snapcraft.yaml              # Strict snap definition
├── pyproject.toml              # Python packaging metadata
└── SPEC.md                     # Historical product specification (architectural history)
```

### Host Utilities & Diagnostic Scripts (Root Directory)
* [clear-ubuntu-uefi-entries.sh](file:///home/ken/src/github/kenvandine/nimbus-appliance/nimbus/clear-ubuntu-uefi-entries.sh) - Cleans up Ubuntu UEFI entries on bare-metal targets.
* [fix-lxd-network.sh](file:///home/ken/src/github/kenvandine/nimbus-appliance/nimbus/fix-lxd-network.sh) - Solves NetworkManager clashes with LXD bridges.
* [verify-lxd-network-fix.sh](file:///home/ken/src/github/kenvandine/nimbus-appliance/nimbus/verify-lxd-network-fix.sh) - Unpacks the pre-built installer image to verify NetworkManager configuration.
* [perf-diag.sh](file:///home/ken/src/github/kenvandine/nimbus-appliance/nimbus/perf-diag.sh) - Gathers host and container performance metrics for debugging.

---

## Building the Appliance Image and ISO

Nimbus supports building pre-seeded appliance images and installer ISOs via the GitHub Actions workflow `Build Appliance Image and ISO` (`.github/workflows/image-iso.yml`). This workflow packages Ubuntu Core along with the configured nimbus snaps and optionally pre-seeds local AI model files so the device boots fully offline-ready.

### Workflow Inputs

When dispatching the workflow, you can specify several options:

* **`model`** (Choice, required): The target appliance model definition to build:
  * `nimbus-lemonade` (default)
  * `nimbus-gemma4`
* **`preseed`** (Boolean, required): Enable preseeding of snaps (pre-configures snaps inside the seed to save time on first boot). Defaults to `true`.
* **`channel`** (String, required): The Snap Store channel/branch to fetch the `nimbus` snap from (e.g. `edge`, `beta`, `stable`). Defaults to `edge`.
* **`release`** (Boolean, required): Creates a GitHub Release with the build artifacts (only works for non-edge channels). Defaults to `false`.
* **`ssh_key`** (String, optional): Public SSH key to embed directly into the Ubuntu Core system-user assertion, allowing passwordless login on first boot.
* **`hf_model_repo`** (String, optional): A HuggingFace model repository to download and pre-seed in the image cache (e.g., `unsloth/Qwen3.5-9B-GGUF`).
* **`hf_model_file`** (String, optional): Specific model file to download from the HuggingFace repository (e.g., `Qwen3.5-9B-Q4_K_M.gguf`). If left empty, the workflow downloads the entire snapshot.

### Example: Building with Qwen3.5-9B-GGUF Pre-seeded

To build an installer ISO containing the `nimbus-lemonade` appliance pre-loaded with the `Qwen3.5-9B` model, trigger the workflow with the following parameters:

1. Go to the **Actions** tab in your repository.
2. Select the **Build Appliance Image and ISO** workflow.
3. Click **Run workflow** and fill in:
   * **Appliance Model to build**: `nimbus-lemonade`
   * **Nimbus Snap Channel/Branch**: `edge` (or whichever branch has your changes)
   * **Optional HuggingFace model repository**: `unsloth/Qwen3.5-9B-GGUF`
   * **Optional HuggingFace model filename/pattern**: `Qwen3.5-9B-Q4_K_M.gguf`
4. Click **Run workflow**.

On build completion:
* The workflow will download `Qwen3.5-9B-Q4_K_M.gguf`.
* It detects the `Qwen3.5-9B-GGUF` repo name and automatically downloads the companion vision file `mmproj-F16.gguf`.
* It packages the cache and pre-writes a custom `model_override.json` so `lemonade-server` defaults to it automatically.
* The pre-seeded model will be bundled into the compiled `.iso` and `.img` files, ready for offline installation.

---

## How apps are installed

In the default configuration (`app-store-type=nimbus`), Nimbus installs apps as classic snaps inside the managed LXD container:

1. The backend fetches the curated catalog JSON from `nimbus-app-store`.
2. When you click **Install**, the snap is installed inside the managed container via `snapd`.
3. LXD proxy devices are created automatically for each snap's exposed ports so apps are reachable from the host network.
4. The UI receives live install progress via SSE.

### Deprecated: Docker / Umbrel app install path

When `app-store-type=umbrel` is set, Nimbus falls back to a Docker Compose install path sourced from the Umbrel git app catalog. **This backend is deprecated and not used in the default configuration.**

When active, the install flow is:

1. The Umbrel git catalog is cloned on startup.
2. The app's `docker-compose.yml` is copied to `/var/lib/nimbus/installed/<app-id>/` and patched for standalone use: the `app_proxy` sidecar is removed, a host port mapping is injected, Compose v1 hostname references are rewritten, and the obsolete `version:` key is dropped.
3. An `.env` file is written with `APP_DATA_DIR`, `APP_SEED`, and `UMBREL_ROOT` set to local paths.
4. All bind-mount directories are pre-created and `docker compose up -d` is run in the background.

App data lives under `/var/lib/nimbus/installed/<app-id>/data/`. Shared storage lives at `/var/lib/nimbus/data/storage`.

### Updating apps

- The UI shows **Update available** when the catalog version differs from the installed version.
- `POST /api/apps/{id}/update` refreshes the app in place.
- `POST /api/apps/check-updates` triggers an explicit update check.

---

## API reference

All endpoints are prefixed with `/api/` and require authentication (session cookie or `Authorization: Bearer <token>` header) unless noted.

### Apps

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/apps` | List all store apps with installed/running status |
| `GET` | `/api/apps/{id}` | Single app detail |
| `POST` | `/api/apps/{id}/install` | Install app (202, background) |
| `POST` | `/api/apps/{id}/update` | Update app (202, background) |
| `POST` | `/api/apps/{id}/uninstall` | Uninstall app and remove volumes |
| `GET` | `/api/apps/{id}/icon.svg` | Generated SVG icon (fallback) |
| `GET` | `/api/apps/{id}/logs` | SSE stream of app container logs |
| `GET` | `/api/apps/installing/active` | List app IDs currently installing |
| `POST` | `/api/apps/check-updates` | Trigger an explicit update check |

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/system/stats` | CPU, RAM, disk, container state, app count |
| `GET` | `/api/system/stats/stream` | SSE stream of stats (2-second interval) |
| `POST` | `/api/system/restart` | Request a host restart via snapd |
| `POST` | `/api/system/poweroff` | Request a host power-off via snapd |
| `POST` | `/api/system/update` | Update host snaps (`core24`, `snapd`, `lxd`, `nimbus`) |
| `POST` | `/api/system/oobe-complete` | Mark the OOBE wizard as complete |
| `GET` | `/api/system/journal` | SSE stream of host (`source=host`) or container (`source=lxc`) logs |
| `GET` | `/api/system/resources` | Get container CPU / memory limits (LXD mode) |
| `PUT` | `/api/system/resources` | Set container CPU / memory limits (LXD mode) |
| `GET` | `/api/system/ca-cert` | Download the Nimbus CA certificate |

### Auth

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Authenticate and receive a session cookie |
| `POST` | `/api/auth/logout` | Invalidate the current session |
| `POST` | `/api/auth/create-account` | Create the initial account (OOBE only) |
| `GET` | `/api/auth/status` | Check auth state (account exists, session valid) |

### Network

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/network/addresses` | All host network addresses |
| `GET` | `/api/network/wifi/status` | Wi-Fi connection status |
| `GET` | `/api/network/wifi/networks` | Scan for available Wi-Fi networks |
| `POST` | `/api/network/wifi/connect` | Connect to a Wi-Fi network |
| `POST` | `/api/network/wifi/disconnect` | Disconnect from Wi-Fi |
| `GET` | `/api/network/dns` | Current DNS servers |
| `PUT` | `/api/network/dns` | Set DNS servers |

### SSH

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/ssh/status` | SSH service status |
| `GET` | `/api/ssh/keys` | List authorized public keys |
| `POST` | `/api/ssh/keys` | Add an authorized public key |
| `DELETE` | `/api/ssh/keys/{fingerprint}` | Remove an authorized key |

### Tailscale

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tailscale/status` | Tailscale connection state and IP (reads `tailscale0` interface via psutil) |
| `GET` | `/api/tailscale/webclient/` | Tailscale web management UI (reverse-proxied from `localhost:8088`) |
| `GET/POST` | `/api/tailscale/webclient/{path}` | Remaining assets and API calls proxied to the local `tailscale web` service |

### Firewall (LXD mode)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/firewall/status` | ufw status (enabled/disabled) |
| `GET` | `/api/firewall/rules` | List firewall rules |
| `POST` | `/api/firewall/rules` | Add a firewall rule |
| `DELETE` | `/api/firewall/rules/{number}` | Delete a firewall rule by number |
| `POST` | `/api/firewall/enable` | Enable ufw |
| `POST` | `/api/firewall/disable` | Disable ufw |

### Snapshots (LXD mode)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/snapshots` | List container snapshots |
| `POST` | `/api/snapshots` | Create a snapshot |
| `DELETE` | `/api/snapshots/{name}` | Delete a snapshot |
| `POST` | `/api/snapshots/{name}/restore` | Restore a snapshot |

### Files

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/files/list` | List files/directories under `files_root` |
| `GET` | `/api/files/read` | Read a file's contents |
| `POST` | `/api/files/write` | Write (create or overwrite) a file |

### AI / Models

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/models/status` | Model provider status and pull state |
| `GET` | `/api/models/available` | List available models |
| `POST` | `/api/models/pull` | Pull the default model |
| `POST` | `/api/models/ensure` | Ensure the default model is present |
| `POST` | `/api/models/select` | Switch the active model, pulling it if needed |

### Cloud Offload

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/cloud/status` | Offload policy, router readiness, and lemonade reachability |
| `GET` | `/api/cloud/presets` | Curated cloud provider presets (Fireworks, OpenAI, OpenRouter, Together) |
| `GET` | `/api/cloud/providers` | Configured cloud providers (keys never returned) |
| `POST` | `/api/cloud/providers` | Add a cloud provider (name, base URL, API key) |
| `DELETE` | `/api/cloud/providers/{provider}` | Remove a cloud provider |
| `GET` | `/api/cloud/providers/{provider}/models` | Chat models discovered from a provider |
| `POST` | `/api/cloud/policy` | Save the offload policy (enable/disable, model, rules) |

### OpenClaw

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/openclaw/status` | OpenClaw reachability, agents, sessions, and model provider state |

### AI Labs Snap Store

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/snap-store/catalog` | AI-Labs snap catalog with install status |
| `POST` | `/api/snap-store/install` | Install a snap in the managed container |
| `DELETE` | `/api/snap-store/{name}` | Remove a snap from the managed container |
| `POST` | `/api/snap-store/{name}/refresh` | Refresh a snap to the latest version |

### API Keys

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/keys` | List named API keys |
| `POST` | `/api/keys` | Set a named API key |
| `DELETE` | `/api/keys/{name}` | Delete a named API key |

### Terminal

| Endpoint | Description |
|---|---|
| `WS /ws/terminal` | Persistent WebSocket terminal session (LXD exec, bash in the managed container) |

---

## Logs and troubleshooting

```bash
# Live Nimbus logs (snap controller)
sudo snap logs nimbus -f

# Live Nimbus logs (local/container mode)
lxc exec nimbus -- journalctl -u nimbus -f

# Container status
lxc info nimbus
lxc info nimbus --show-log

# App container logs (deprecated Docker/Umbrel path only)
lxc exec nimbus -- docker compose -p <app-id> \
  -f /var/lib/nimbus/installed/<app-id>/docker-compose.yml logs -f

# All Docker app containers (deprecated Docker/Umbrel path only)
lxc exec nimbus -- docker ps -a
```

The UI also provides a built-in log viewer under **Settings → Logs** that streams both host and container logs in real time.

### App not reachable

1. Check `sudo snap logs nimbus -n 200`.
2. Check `lxc info nimbus` — container must be `Running`.
3. Check snap or compose logs inside the container (depending on install backend).
4. Confirm you are using the **host LAN IP**, not the LXD bridge/container IP.
5. Check the LXD proxy device exists: `lxc config device show nimbus`.
6. Check `NIMBUS_LXD_PUBLISH_HOST` is `0.0.0.0` (default).

### Bootstrap stuck or failing

The daemon retries the bootstrap up to 5 times, 30 seconds apart. If it remains stuck:

```bash
sudo lxc stop nimbus --force
sudo lxc start nimbus
sudo snap restart nimbus
```

To wipe all app data and start fresh:

```bash
sudo nimbus.reset
```

---

## Known limitations

- **App compatibility**: The default snap-based catalog only includes apps explicitly curated for the appliance experience. The deprecated Docker/Umbrel backend supports a broader set of apps but may encounter compatibility issues with apps that depend on Umbrel-specific infrastructure.
- **Single user**: Only one account is supported. The UI is intended for local-network use.
- **Remote mode**: `NIMBUS_CONTROL_MODE=remote` exists in the code but `lxd` mode is the primary supported path.

---

## Contributing Translations

Nimbus supports multilingual experiences. If you want to contribute translations for a new language, follow these steps:

1. **Locate the Translation File**:
   All translations are stored in [frontend/src/i18n.jsx](frontend/src/i18n.jsx).

2. **Add Your Language Dictionary**:
   Inside `i18n.jsx`, find the `translations` constant. Add a new dictionary with your language's ISO 639-1 code (e.g., `de` for German, `it` for Italian) alongside `en`, `es`, and `fr`. Copy the keys from `en` and translate their values:
   ```javascript
   const translations = {
     en: { ... },
     es: { ... },
     fr: { ... },
     de: {
       loading: "Laden…",
       cancel: "Abbrechen",
       // Add the rest of translated keys here
     }
   };
   ```
   *Note: Preserve formatting parameters enclosed in double curly braces, such as `{{ssid}}` or `{{error}}` (e.g., `Conectado a "{{ssid}}"`).*

3. **Register the Language**:
   Register your language in the `languages` array inside the `TranslationProvider` component near the bottom of `i18n.jsx`:
   ```javascript
   const languages = [
     { code: 'en', label: 'English' },
     { code: 'es', label: 'Español' },
     { code: 'fr', label: 'Français' },
     { code: 'de', label: 'Deutsch' }, // Add your language here
   ];
   ```

4. **Verify Locally**:
   To test your translations, navigate to the `frontend/` directory and compile the interface:
   ```bash
   cd frontend
   npm run build
   ```
   Select your language from the dropdown menu in the OOBE (Out-of-Box Experience) setup screen or in the settings panel to verify correct contrast and word wrapping.

