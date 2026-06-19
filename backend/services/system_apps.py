from __future__ import annotations

import base64

from config import MODEL_PROVIDER_GEMMA4, settings
from constants import LEMONADE_PORT
from models import AppDetail

# SVG icon: dark rounded square with a 🍋 emoji centred
_LEMONADE_SVG = """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#1a1a2e"/>
  <text x="32" y="46" font-size="38" text-anchor="middle" font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif">&#x1F34B;</text>
</svg>"""

_LEMONADE_ICON = "data:image/svg+xml;base64," + base64.b64encode(_LEMONADE_SVG.encode()).decode()

# SVG icon for the gemma4 inference snap: dark rounded square with a 💎 glyph.
_GEMMA4_SVG = """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#1a1a2e"/>
  <text x="32" y="46" font-size="38" text-anchor="middle" font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif">&#x1F48E;</text>
</svg>"""

_GEMMA4_ICON = "data:image/svg+xml;base64," + base64.b64encode(_GEMMA4_SVG.encode()).decode()


def get_lemonade_app(host_ip: str | None) -> AppDetail:
    open_url = f"http://{host_ip}:{LEMONADE_PORT}" if host_ip else None
    return AppDetail(
        id="lemonade",
        name="Lemonade",
        tagline="Local Lemonade instance",
        description=f"Opens the Lemonade service running on the host at port {LEMONADE_PORT}.",
        icon=_LEMONADE_ICON,
        port_hint=LEMONADE_PORT,
        installed=True,
        running=True,
        port=LEMONADE_PORT,
        open_url=open_url,
        is_system=True,
    )


def get_gemma4_app(host_ip: str | None) -> AppDetail:
    # Imported lazily so the system_apps module doesn't pay for httpx on
    # every list_apps() — and so any port probe failures don't crash the dock.
    from services import gemma4

    port = gemma4.discover_port() or gemma4.GEMMA4_DEFAULT_PORT
    open_url = f"http://{host_ip}:{port}" if host_ip else None
    return AppDetail(
        id="gemma4",
        name="Gemma4",
        tagline="Local Gemma4 inference snap",
        description=f"Opens the Gemma4 inference service running on the host at port {port}.",
        icon=_GEMMA4_ICON,
        port_hint=port,
        installed=True,
        running=True,
        port=port,
        open_url=open_url,
        is_system=True,
    )


async def get_system_apps(host_ip: str | None) -> list[AppDetail]:
    if settings.model_provider == MODEL_PROVIDER_GEMMA4:
        return []
    return [get_lemonade_app(host_ip)]
