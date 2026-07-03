## Nimbus UI conventions

Nimbus UI is a **dark-theme** React design system for the Nimbus home-server
appliance. Components are plain React components, styled entirely with **CSS
custom-property tokens** — there are no utility classes and no CSS-in-JS.

### Setup — this is a DARK theme (required)

Every screen must sit on the Nimbus canvas. The components use translucent
light-on-dark surfaces, near-white text, and `soft`/`ghost`/`secondary` button
variants — on a white/default background they wash out or vanish. Wrap your app
root:

```jsx
<div style={{
  minHeight: '100vh',
  background: 'var(--color-bg-canvas)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-sans)',
}}>
  {/* screens go here */}
</div>
```

Tokens ship in `styles.css` (imported once). There is **no theme provider** —
components read the tokens directly, so no wrapper is required around them.

### Styling idiom — tokens, not classes

Style the library components through their **props** (`variant`, `size`,
`tone`, …). Style your own layout glue with **inline styles that reference
`var(--*)` tokens** — never invent class names, never hardcode a hex value.
Token families (all defined in `styles.css`):

- Surfaces / text: `--color-bg-canvas`, `--color-surface-1|2|3`,
  `--color-border-subtle|strong`, `--text-primary|secondary|tertiary|disabled`
- Accent + status — each has a `-soft-bg` / `-soft-border` / `-soft-text`
  triplet for pills & badges: `--color-accent`, `--color-success`,
  `--color-warning`, `--color-danger`, `--color-info`
- Spacing (4px grid): `--space-1` … `--space-10`
- Radius: `--radius-sm|md|lg|xl|full`
- Type: `--font-sans`, `--font-mono`, `--font-size-xs|sm|md|lg|xl|2xl`,
  `--font-weight-regular|medium|bold`
- Shadow: `--shadow-sm|md|lg|xl`; Motion: `--ease-standard`,
  `--duration-fast|base`

### Components

Read each component's `.d.ts` (props) and `.prompt.md` (usage) before composing.
Key APIs:

- `Button` — `variant`: primary | soft | secondary | danger | ghost; `size`:
  md | sm; plus `loading`, `disabled`, `fullWidth`.
- `Badge`, `StatusDot` — `tone`: accent | info | success | warning | danger |
  neutral.
- `Modal` — transient overlay (`title`, `footer`, `onClose`).
- `Panel` / `SettingsSection` / `SettingsRow` — grouped settings surfaces;
  `SettingsRow` is meant to be stacked inside a `Panel`/`SettingsSection`.
- `AppTile` — launcher grid tile (takes an `app` object).
- `PinPad` + `PinDots`, `PasswordField`, `SignalBars`, `Spinner`, `NimbusMark`.

### Example

```jsx
import { SettingsSection, SettingsRow, Button, StatusDot } from 'nimbus-ui'

<div style={{ minHeight: '100vh', background: 'var(--color-bg-canvas)', color: 'var(--text-primary)', fontFamily: 'var(--font-sans)', padding: 'var(--space-6)' }}>
  <SettingsSection title="Device">
    <SettingsRow label="Wi-Fi" sub="Nimbus-5G">
      <StatusDot tone="success" label="Online" />
    </SettingsRow>
    <SettingsRow label="Automatic updates" sub="Nightly">
      <Button variant="soft" size="sm">Check now</Button>
    </SettingsRow>
  </SettingsSection>
</div>
```
