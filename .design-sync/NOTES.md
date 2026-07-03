# Nimbus UI — design-sync notes

Repo-specific gotchas for future syncs.

- **This is a private Vite app, not a published component library.** There is no
  `dist/` and no shipped `.d.ts`. The design-system surface is the barrel
  `frontend/src/components/ui/index.js` (14 exports). Everything else under
  `frontend/src` is app screens — NOT design-system components.
- **Build invocation** (from repo root):
  ```
  node .ds-sync/package-build.mjs --config .design-sync/config.json \
    --node-modules frontend/node_modules \
    --entry ./frontend/src/components/ui/index.js --out ./ds-bundle
  ```
  `PKG_DIR` resolves to `frontend/` (the nearest named package.json), so all
  package-relative config paths (`cssEntry`, `srcDir`, `componentSrcMap`,
  `extraFonts`) are relative to `frontend/`.
- **Why the barrel is the entry + why componentSrcMap pins every component:**
  components are plain `.jsx` with `export default`. With no `.d.ts`, `.d.ts`
  discovery finds nothing; synth-entry's `export *` would miss the default
  exports. The barrel does proper named re-exports (`export { default as Button }`),
  so it produces a correct `window.NimbusUI`. `componentSrcMap` supplies the
  component list explicitly (14) since there is no `.d.ts` to derive it from.
- **`Page` and `PageHeader` are intentionally excluded** — they live in
  `components/ui/` but are NOT in the barrel, and `PageHeader` needs a
  react-router `<Router>` to render. Do not add them.
- **Styling idiom: CSS-variable tokens only.** All components style via inline
  styles referencing `var(--*)` tokens defined in `frontend/src/theme.css`.
  There are no CSS classes and no CSS-in-JS, so `_ds_bundle.css` is expected to
  be near-empty; the styling comes entirely from theme.css tokens shipping in
  `styles.css`.
- **Fonts:** theme.css declares `@font-face` for Ubuntu Sans / Ubuntu Mono with
  absolute `/fonts/*.woff2` URLs (served by the app at runtime). Actual files are
  at `frontend/public/fonts/`. Wired via `cfg.extraFonts` (bare woff2 → copied to
  `ds-bundle/fonts/`).

## Preview authoring — dark theme (IMPORTANT)

- **Nimbus is a dark-theme DS.** Components use translucent light-on-dark tokens.
  The design tool's preview card is hardcoded white (`body{background:#fff}` in
  emit.mjs — do NOT fork), so components wash out / vanish (ghost & secondary
  buttons become invisible; Modal goes white-on-white).
- **Fix (global):** `.design-sync/preview-theme.jsx` exports `NimbusPreviewTheme`,
  a wrapper that paints the Nimbus dark canvas + light text. It's merged into the
  bundle via `cfg.extraEntries` and wired as `cfg.provider`, so EVERY story renders
  on dark automatically. This is preview-only; it is not public API and never
  appears in a real design. Keep it.
- **Overlay components** (Modal, anything `position:fixed inset:0`): in single/
  capture mode `.ds-single` collapses to content height, so a fixed scrim only
  fills a thin band and the white body shows through. Give the story a
  `min-height` wrapper so the scrim fills a tall dark canvas. See `previews/Modal.tsx`.
- Preview import convention: `import { X } from 'nimbus-ui'` (→ window.NimbusUI),
  `import * as React from 'react'`. Each capitalized named export = one card cell.

## Known render warns (accepted — do not re-chase)

- `[FONT_DANGLING] "ubuntu sans" / "ubuntu mono"` — the generated
  `fonts/fonts.css` keeps theme.css's **absolute** `/fonts/*.woff2` URLs. This is
  a static-check false positive: the woff2 files DO ship in `ds-bundle/fonts/`,
  and both the validator (serves at http root) and claude.ai/design (serves DS
  files at project root) resolve `/fonts/...` correctly. `/fonts/` is this DS's
  own runtime serving convention. Verified: fonts load in the render check.
- `[FONT_MISSING] "Cascadia Code", "Fira Code" (--font-mono)` — these are just
  fallback names in the `--font-mono` stack, NOT fonts the DS ships. The primary
  (Ubuntu Mono) ships. Legitimately absent; no action.
- `[RENDER_BLANK]/[RENDER_THIN]` on content-driven components with empty
  smart-defaults (Badge, Panel, StatusDot, SignalBars, PinDots, SettingsRow,
  SettingsSection, NimbusMark) — resolved by authoring their previews. Not a
  pipeline bug.

## Environment / build

- **Faithful install:** `frontend/` uses `package-lock.json` → `npm ci`. The
  repo's checked-out `node_modules` was incomplete (missing `lucide-react`,
  `react-router-dom`); run `npm ci` in `frontend/` before building.
- `@types/react` is NOT a declared dep — add it unsaved for prop extraction:
  `cd frontend && npm i --no-save @types/react`. Without it `[DTS_REACT]` warns
  (harmless here — components use plain destructured props, not React utility
  types).
- **Render browser:** no playwright/chromium is cached. Instead of the ~200MB
  download, the validator/capture drive the system Chrome via
  `DS_CHROMIUM_PATH=/usr/bin/google-chrome`. Install only the JS package:
  `cd .ds-sync && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright`.

## Re-sync risks (what can silently go stale)

- **`preview-theme.jsx` is tied to the DS being dark.** If Nimbus ever ships a
  light mode or the canvas token changes, revisit the wrapper. It hardcodes
  `--color-bg-canvas`.
- **`conventions.md` enumerates token names.** If `theme.css` renames/removes a
  token (e.g. a `--color-*` or `--space-*`), the header goes stale — re-validate
  the names against `_ds_bundle.css` on every re-sync (the authoring step does
  this automatically).
- **Component set is pinned by `componentSrcMap` (14 entries).** New primitives
  added to `frontend/src/components/ui/index.js` will NOT appear until added to
  `componentSrcMap`. Keep the two in sync. `Page`/`PageHeader` are deliberately
  excluded.
- **Fonts use absolute `/fonts/` URLs.** Works because both the validator and
  claude.ai/design serve at project root; if that serving model ever changes,
  fonts would 404 (see Known render warns).
- **AppTile preview uses inline data-URI SVG icons** (the real component expects
  an `app.icon` URL). Purely cosmetic for the card; no upstream tie.
