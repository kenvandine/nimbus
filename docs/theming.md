# Theming Nimbus

Nimbus's entire frontend is styled from a single set of CSS custom properties
(`frontend/src/theme.css` in the source tree) — colors, spacing, radius,
shadows, and fonts. There is no build step involved in overriding them: drop
a stylesheet on the device at runtime and the whole UI picks it up.

## The override directory

Nimbus serves a writable directory at `/theme/`:

| Env var | Default | Notes |
|---|---|---|
| `NIMBUS_THEME_DIR` | `$SNAP_COMMON/theme` (or `/var/lib/nimbus/theme` outside a snap) | Set to point at a different location if needed. |

`$SNAP_COMMON` is used (not `$SNAP`, which is the read-only squashfs) because
it's writable and survives snap refreshes. On first run Nimbus creates the
directory with a `README.md` if nothing is there yet — it never touches an
existing file.

Nothing in this directory is required. An install with an empty (or
nonexistent) override directory looks exactly like stock Nimbus; every file
Nimbus looks for there is optional and 404s cleanly if absent.

## override.css

Redeclare any token from `theme.css` and it applies everywhere that token is
used — buttons, badges, focus rings, backgrounds, the ambient home-screen
gradient, even the terminal and QR-code colors (see "What isn't pure CSS"
below for why those need special handling internally).

```css
:root {
  --color-accent: #3E8CA8;         /* primary buttons, focus rings, active states */
  --color-accent-hover: #56ABC6;
  --color-bg-canvas: #0a0f14;      /* base background */
  --font-sans: 'Inter', sans-serif;
  --nimbus-gradient-hue: 200;      /* hue (0-360) of the animated home-screen background */
}
```

The full token list — primitives (`--nimbus-charcoal-*`, `--nimbus-sun-*`,
`--nimbus-sky-*`, ...) and semantic tokens built from them
(`--color-accent`, `--color-surface-1`, `--text-primary`, ...) — is in
`frontend/src/theme.css`. Overriding a primitive re-colors everything
derived from it; overriding a semantic token changes just that one thing.

## logo.svg

Drop a square SVG here to replace the cloud logomark shown on the
onboarding, login, and kiosk-ready screens. Any viewBox works — it's
rendered at a fixed pixel size via `<img>`.

## What isn't pure CSS

Two things render outside the DOM and can't be reached by a stylesheet
alone: the in-browser terminal (`xterm.js` paints to a `<canvas>`) and the
QR code on the kiosk-ready screen (`qrcode` also paints to a `<canvas>`).
Both read the same CSS custom properties as everything else, but do so in
JavaScript via `getComputedStyle` at the moment they're created — see
`getXtermTheme()`/`getQrColors()` in `frontend/src/theme.js` — so overriding
the underlying tokens (`--color-bg-canvas`, `--nimbus-sky-500`, etc.) still
reaches them; there's just no separate "terminal colors" config surface.

## Testing an override without a real device

Point a static file server at a directory containing the built frontend
(`backend/static/`) plus a `theme/` subdirectory with your files, and load
it in a browser — this is exactly what the backend's two mounts (`/` and
`/theme/`) look like from the frontend's perspective.
