# Theme examples

Nimbus's entire UI is styled from CSS custom properties defined in one
place (`frontend/src/theme.css`). An operator can restyle the whole app —
colors, radii, shadows, blur — without rebuilding the frontend, by dropping
an `override.css` file into a writable directory the backend serves at
`/theme/override.css` (see `backend/main.py` / `backend/config.py`).

Nimbus (both its own default theme and every example here) now supports
light and dark mode automatically, following the OS/browser's
`prefers-color-scheme` — there's no manual toggle, and no override needed
just to get light mode out of the box. This directory contains three
ready-to-use example override files, each with both a dark and a light
variant, so you can confirm theming works end-to-end on a real device:

| File | Look |
|---|---|
| `ubuntu-vanilla-theme.css` | Matches Canonical's [Vanilla design system](https://design.ubuntu.com/vanilla) — Ubuntu orange accent, neutral grey surfaces, small/flat corners. Both variants use vanilla-framework's actual light- and dark-theme tokens. |
| `business-theme.css` | Restrained and professional — cool slate-navy (dark) / pale blue-grey (light), muted steel-blue accent, moderate corners. Aimed at a mid-sized-company deployment. |
| `family-fun-theme.css` | Vivid and playful — bubblegum-pink accent, candy-colored status colors, bubbly rounded corners, on an indigo-night (dark) or pale-pink (light) canvas. Aimed at a household with kids. |

## How light/dark mode works here

`frontend/src/theme.css` defines Nimbus's dark theme as the unconditional
`:root` block, then a `@media (prefers-color-scheme: light)` block
redeclares only what needs to flip: canvas/surfaces/borders, the text
ladder, the four `--color-*-soft-text` tints, shadows, and
`--nimbus-gradient-lightness`. Each example theme file follows the same
two-block structure. A few things this uncovered, worth knowing before
writing your own:

- **The Home screen's ambient gradient** (`frontend/src/theme.js`,
  `ambientGradient()`) used to have its lightness hardcoded dark — only hue
  was overridable. A light theme that didn't also raise
  `--nimbus-gradient-lightness` would leave a dark, unreadable patch behind
  the Home screen's app icons even with everything else flipped light.
  Fixed by exposing `--nimbus-gradient-lightness` (default `7`) alongside
  the existing `--nimbus-gradient-hue` — every light block here sets it to
  somewhere around 88-90.
- **The four soft-status text colors** (`--color-accent-soft-text` and the
  info/success/warning/danger equivalents) pair a translucent tinted
  background with a *light* text color, tuned to pop against a dark
  surface. On a light canvas that same light text reads as a low-contrast
  wash — this is what made the Settings "Download" button and the active
  dock icon look washed-out in earlier testing. Each light block
  redeclares just these four with deep, saturated shades instead; the
  soft-bg/soft-border translucent tints are left alone since they read
  fine as a pale panel over either canvas.
- **`--nimbus-charcoal-900`** (the native `<select>` option background and
  hover-tooltip chip background) is deliberately *not* part of the
  light/dark flip in any of these files — it doubles as the terminal's ANSI
  "black" text color (`theme.js` `getXtermTheme()`), which must stay dark
  regardless of mode so black terminal text doesn't vanish against the
  (correctly light-flipping) terminal background. The default theme fixed
  this properly by pointing the `select option` CSS rule at
  `--color-bg-canvas` instead of the primitive; the example theme files
  don't touch `<select>` styling at all, so they inherit that fix for free.

## Try one on a running device

The backend seeds a writable override directory at `$SNAP_COMMON/theme`,
which on an installed snap is `/var/snap/nimbus/common/theme`:

```bash
scp examples/business-theme.css ubuntu@nimbus.local:/tmp/override.css
ssh ubuntu@nimbus.local 'sudo cp /tmp/override.css /var/snap/nimbus/common/theme/override.css'
```

Reload the UI (or wait for the next natural page load) to see it applied —
no rebuild or restart needed, other than the frontend build itself already
including the `--nimbus-gradient-lightness` support above (anything built
before that change won't respond to it). To go back to the default Nimbus
theme, remove the override:

```bash
ssh ubuntu@nimbus.local 'sudo rm /var/snap/nimbus/common/theme/override.css'
```

To see the light variant, switch your OS/desktop's light/dark preference —
there's no in-app toggle. In a regular (non-kiosk) browser you can instead
force it via devtools: Chrome/Edge DevTools → Rendering tab → "Emulate CSS
media feature prefers-color-scheme".

## Try one during local frontend development

Copy a file to `frontend/public/theme/override.css` (untracked, safe to
create) before running `npm run dev` — Vite serves `public/` at the site
root, matching where the built snap serves its own `/theme/` override.

## Writing your own

See the full token list and their meanings in `frontend/src/theme.css`, and
the example files here for which ones are worth redeclaring together (the
primitive `--nimbus-*` scales are read directly by a few components and by
`frontend/src/theme.js` for the terminal, QR code, and ambient gradient, not
just the semantic `--color-*`/`--text-*` layer). Give your override both a
`:root { ... }` block and a `@media (prefers-color-scheme: light) { :root
{ ... } }` block if you want it to support both modes like the examples
here — a single `:root` block works too, it just won't adapt to the
system's light/dark preference.
