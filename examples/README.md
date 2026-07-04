# Theme examples

Nimbus's entire UI is styled from CSS custom properties defined in one
place (`frontend/src/theme.css`). An operator can restyle the whole app —
colors, radii, shadows, blur — without rebuilding the frontend, by dropping
an `override.css` file into a writable directory the backend serves at
`/theme/override.css` (see `backend/main.py` / `backend/config.py`).

This directory contains three ready-to-use example override files so you
can confirm theming works end-to-end on a real device:

| File | Look |
|---|---|
| `ubuntu-vanilla-theme.css` | Matches Canonical's [Vanilla design system](https://design.ubuntu.com/vanilla) — Ubuntu orange accent, neutral dark-grey surfaces, small/flat corners. |
| `business-theme.css` | Restrained and professional — cool slate-navy base, muted steel-blue accent, moderate corners. Aimed at a mid-sized-company deployment. |
| `family-fun-theme.css` | Vivid and playful — bubblegum-pink accent, candy-colored status colors, bubbly rounded corners. Aimed at a household with kids. |

All three keep Nimbus's dark canvas rather than switching to a light
background. The Home screen's ambient gradient (`frontend/src/theme.js`,
`ambientGradient()`) only reads `--nimbus-gradient-hue` for its color — its
lightness is hardcoded assuming a dark canvas — so a light-background theme
would leave a dark patch behind the Home screen's app icons. Each file's
header comment explains its specific color choices.

## Try one on a running device

The backend seeds a writable override directory at `$SNAP_COMMON/theme`,
which on an installed snap is `/var/snap/nimbus/common/theme`:

```bash
scp examples/business-theme.css ubuntu@nimbus.local:/tmp/override.css
ssh ubuntu@nimbus.local 'sudo cp /tmp/override.css /var/snap/nimbus/common/theme/override.css'
```

Reload the UI (or wait for the next natural page load) to see it applied —
no rebuild or restart needed. To go back to the default Nimbus theme,
remove the override:

```bash
ssh ubuntu@nimbus.local 'sudo rm /var/snap/nimbus/common/theme/override.css'
```

## Try one during local frontend development

Copy a file to `frontend/public/theme/override.css` (untracked, safe to
create) before running `npm run dev` — Vite serves `public/` at the site
root, matching where the built snap serves its own `/theme/` override.

## Writing your own

See the full token list and their meanings in `frontend/src/theme.css`, and
the example files here for which ones are worth redeclaring together (the
primitive `--nimbus-*` scales are read directly by a few components and by
`frontend/src/theme.js` for the terminal, QR code, and ambient gradient, not
just the semantic `--color-*`/`--text-*` layer).
