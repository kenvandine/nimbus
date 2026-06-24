"""Centralized configuration constants for Nimbus.

All magic numbers, port assignments, file paths, version markers, and
LXD defaults live here so they can be changed in a single place and
imported consistently across the codebase.
"""

from pathlib import Path

# ---------------------------------------------------------------------------
# Ports
# ---------------------------------------------------------------------------

# LXD-host agent port (the nimbus FastAPI backend inside the LXC).
LXD_AGENT_PORT: int = 9001

# LXC agent daemon port (the asyncio HTTP daemon on port 9002).
LXC_AGENT_PORT: int = 9002

# Lemonade model-provider snap port.
LEMONADE_PORT: int = 13305

# Gemma4 inference snap port.
GEMMA4_PORT: int = 8336

# OpenClaw gateway WebSocket port.
OPENCLAW_PORT: int = 18790

# OpenClaw setup-server HTTP UI port.
OPENCLAW_UI_PORT: int = 18789

# Fallback UI ports for snaps whose catalog entries don't include a `ports`
# field.  These are used to build the Open URL and set up the LXD proxy
# device.  Prefer adding ports to the catalog; this dict is a
# belt-and-suspenders safety net for first-party apps that Nimbus knows by
# name.
#
# Only snaps that expose a local HTTP UI are listed here.  Agent/gateway
# snaps All known snap UI ports.
SNAP_UI_PORTS: dict[str, int] = {
    "openclaw":     18789,  # setup-server / web UI (OPENCLAW_UI_PORT)
    "zeroclaw":     3000,   # HTTP/WebSocket gateway with built-in web UI
    "odysseus":     7000,   # full browser UI (ODYSSEUS_PORT default)
    "hermes-agent": 9119,   # web UI / gateway
    "nullclaw":     32123,  # web UI / gateway
    "picoclaw":     18800,  # web UI / gateway
}

# ---------------------------------------------------------------------------
# DNS servers
# ---------------------------------------------------------------------------

# Default DNS servers for the container Docker daemon.
DOCKER_DNS_SERVERS: list[str] = ["1.1.1.1", "8.8.8.8"]

# Default DNS servers for the LXC container network (used by NetworkManager
# DNS management).
CONTAINER_DNS_SERVERS: list[str] = ["1.1.1.1", "1.0.0.1"]

# DNS servers used by the LXC agent daemon for health checks.
AGENT_DNS_SERVERS: list[str] = ["1.1.1.1", "8.8.8.8"]

# ---------------------------------------------------------------------------
# Model provider URLs
# ---------------------------------------------------------------------------

MODEL_PROVIDER_URLS: dict[str, str] = {
    "lemonade-server": "http://127.0.0.1:13305/api/v1",
    "inference-snap-gemma4": "http://127.0.0.1:8336/v1",
}

# ---------------------------------------------------------------------------
# Container paths
# ---------------------------------------------------------------------------

CONTAINER_INSTALLED_DIR: Path = Path("/var/lib/nimbus/installed")
CONTAINER_OVERLAY_DIR: str = "/opt/nimbus/openclaw-overlay"
CONTAINER_OPENCLAW_WORKSPACE: str = (
    "/var/lib/nimbus/installed/openclaw/data/data/.openclaw/workspace"
)

# ---------------------------------------------------------------------------
# Bootstrap / version markers
# ---------------------------------------------------------------------------

BOOTSTRAP_VERSION: str = "1"
LXC_AGENT_VERSION: str = "20"
BACKEND_VERSION: str = "3"

BOOTSTRAP_MARKER_PATH: str = "/var/lib/nimbus/.agent-bootstrap-version"
PACKAGES_MARKER_PATH: str = "/var/lib/nimbus/.packages-preinstalled"
AGENT_PYTHON_MARKER_PATH: str = "/var/lib/nimbus/.agent-python-preinstalled"
NIMBUS_USER_MARKER_PATH: str = "/var/lib/nimbus/.nimbus-user-setup"
LXC_AGENT_VERSION_MARKER_PATH: str = "/var/lib/nimbus/.lxc-agent-version"
BACKEND_VERSION_MARKER_PATH: str = "/var/lib/nimbus/.backend-version"

# ---------------------------------------------------------------------------
# LXD defaults
# ---------------------------------------------------------------------------

DEFAULT_LXD_STORAGE_POOL: str = "default"
DEFAULT_LXD_PROFILE: str = "default"
DEFAULT_LXD_BRIDGE_PREFIX: str = "lxdbr"

# ---------------------------------------------------------------------------
# Snap proxy device naming
# ---------------------------------------------------------------------------

PROVIDER_PROXY_DEVICE_NAME: str = "nimbus-provider-fwd"
LXC_AGENT_PROXY_DEVICE_NAME: str = "nimbus-lxc-agent"
