This is a solid architectural challenge. By using **Nimbus** (the LXD container) as a "nested mothership," you create a highly portable and isolated environment.

Below is the **Product Specification** and **Implementation Plan** designed for an AI agent or developer to execute.

---

# Product Spec: Nimbus (Private Cloud Orchestrator)

## 1. Overview
Nimbus is a self-hosted web service that runs inside a **privileged LXD container**. It provides a "Personal App Store" experience by fetching app metadata from the Umbrel repository and orchestrating them as **Docker containers nested inside the LXD container**.

## 2. Core Architecture
- **Host Layer:** Linux OS running LXD.
- **Orchestrator Layer (Nimbus):** An LXD container running a Node.js or Python backend + Web UI.
- **Workload Layer:** Docker Engine running *inside* the Nimbus LXD container.
- **Networking:** Nimbus manages an internal proxy (Nginx or Traefik) to route traffic from subdirectories or unique ports to the nested Docker containers.

## 3. Features
- **App Discovery:** Pulls live data from `getumbrel/umbrel-apps`.
- **One-Click Install:** Nimbus downloads the `docker-compose.yml`, modifies it for the LXD environment, and runs `docker compose up -d`.
- **Unified Dashboard:** Shows running apps, resource usage, and "Open" buttons for web interfaces.
- **Port Management:** Automatically maps nested container ports to the LXD container’s IP.

---

# Implementation Plan

## Phase 1: The Nimbus "Mothership" (LXD Setup)
The Nimbus container needs specific flags to allow nested Docker.

1.  **Create LXD Profile:**
    ```bash
    lxc profile create nimbus-hosting
    lxc profile set nimbus-hosting security.nesting=true
    lxc profile set nimbus-hosting security.syscalls.intercept.mknod=true
    lxc profile set nimbus-hosting security.syscalls.intercept.setxattr=true
    ```
2.  **Launch Container:**
    ```bash
    lxc launch ubuntu:22.04 nimbus --profile default --profile nimbus-hosting
    ```
3.  **Bootstrap Container:**
    - Install `docker.io` and `docker-compose-v2`.
    - Install `nodejs` (for the backend).
    - Install `git` (to clone the app store).

## Phase 2: App Store Logic (The Parser)
The backend must treat `https://github.com/getumbrel/umbrel-apps` as its source of truth.

1.  **Clone/Update Repo:** On startup, Nimbus clones the repo to `/var/lib/nimbus/store`.
2.  **Metadata Extraction:** - Iterate through folders (e.g., `apps/immich/`).
    - Parse `umbrel-app.yml` for the name, icon, and description.
    - Parse `docker-compose.yml` to identify the "web" service and its internal port.

## Phase 3: The Orchestrator (Install/Start)
When a user clicks "Install":

1.  **Prepare Directory:** Create `/var/lib/nimbus/installed/<app-id>`.
2.  **Dynamic Compose Modification:** - Copy the original `docker-compose.yml`.
    - Inject an environment variable or label so Nimbus can track it.
    - **Critical:** Ensure volumes are mapped to local paths within the LXD container.
3.  **Execution:** Run `docker compose -p <app-id> up -d` via a shell-out command.

## Phase 4: The Proxy (Access Logic)
To provide the "Open" button experience:

1.  **Port Discovery:** Nimbus inspects the running container to find the host port mapped to the web UI.
2.  **Access URL:** If Nimbus is at `10.0.0.50`, and Immich maps to `8080`, the "Open" button links to `http://10.0.0.50:8080`.
3.  **Optional Reverse Proxy:** Use a single Nginx instance inside Nimbus that dynamically generates configs:
    - `http://nimbus.local/apps/immich` -> `localhost:8080`.

---

# Agent Instructions (Copy-Paste this)

> "Build a web application named **Nimbus** inside an Ubuntu-based LXD container. 
> 1. **Backend:** Use Node.js (Express) or Python (FastAPI). It must use the `child_process` or `subprocess` module to run Docker commands.
> 2. **Metadata:** Fetch app data from `https://github.com/getumbrel/umbrel-apps`. Parse the YAML files in each subdirectory to display an 'App Store' in the frontend.
> 3. **Installation:** When 'Install' is triggered, the backend should:
>    - Create a folder for the app.
>    - Execute `docker compose up -d`.
>    - Track the status (Installing -> Running).
> 4. **Frontend:** A clean, modern React or Vue dashboard. Each app card has an 'Install' or 'Open' button.
> 5. **Networking:** Ensure the LXD container is configured with `security.nesting=true`. The web UI should provide links to the installed apps based on the LXD container's IP and the mapped Docker ports."

### Witty Extra: The "Cloud-Native" Touch
Since you chose **Nimbus**, make the UI background a subtle, animated gradient of "stormy blue" to "clear sky" to reflect the state of the server (e.g., darker when many apps are installing, brighter when everything is healthy).
