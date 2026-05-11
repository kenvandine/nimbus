from __future__ import annotations

import base64

from models import AppDetail

LEMONADE_PORT = 13305

# SVG icon: dark rounded square with a 🍋 emoji centred
_LEMONADE_SVG = """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#1a1a2e"/>
  <text x="32" y="46" font-size="38" text-anchor="middle" font-family="Apple Color Emoji,Segoe UI Emoji,Noto Color Emoji,sans-serif">&#x1F34B;</text>
</svg>"""

_LEMONADE_ICON = "data:image/svg+xml;base64," + base64.b64encode(_LEMONADE_SVG.encode()).decode()


def get_lemonade_app(host_ip: str | None) -> AppDetail:
    open_url = f"http://{host_ip}:{LEMONADE_PORT}" if host_ip else None
    return AppDetail(
        id="lemonade",
        name="Lemonade",
        tagline="Local Lemonade instance",
        description="Opens the Lemonade service running on the host at port 13305.",
        icon=_LEMONADE_ICON,
        port_hint=LEMONADE_PORT,
        installed=True,
        running=True,
        port=LEMONADE_PORT,
        open_url=open_url,
        is_system=True,
    )


async def get_system_apps(host_ip: str | None) -> list[AppDetail]:
    return [get_lemonade_app(host_ip)]
