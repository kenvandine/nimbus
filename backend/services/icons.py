from __future__ import annotations
import hashlib

# Palette of pleasant background colors
_PALETTE = [
    "#3b6fd4", "#7c3aed", "#0891b2", "#059669", "#d97706",
    "#dc2626", "#db2777", "#2563eb", "#7c3aed", "#0d9488",
    "#16a34a", "#ca8a04", "#ea580c", "#9333ea", "#0284c7",
]


def _color_for(app_id: str) -> str:
    idx = int(hashlib.md5(app_id.encode()).hexdigest(), 16) % len(_PALETTE)
    return _PALETTE[idx]


def generate_icon_svg(app_id: str, name: str) -> str:
    color = _color_for(app_id)
    initials = "".join(w[0].upper() for w in name.split()[:2]) or app_id[0].upper()
    font_size = 40 if len(initials) == 1 else 30
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="80" height="80">
  <rect width="80" height="80" rx="18" fill="{color}"/>
  <text x="40" y="40" dominant-baseline="central" text-anchor="middle"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="{font_size}" font-weight="700" fill="white">{initials}</text>
</svg>"""
