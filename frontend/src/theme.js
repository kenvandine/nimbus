// JS mirror of theme.css's primitive values, for the few places CSS variables
// can't reach directly: canvas-rendered text (xterm.js) and <canvas> drawing
// (QR code). Both read the *live* CSS custom properties via cssVar() rather
// than hardcoded values, so a theme override dropped in $SNAP_COMMON/theme
// (see /theme/override.css, mounted by the backend) reaches these surfaces
// too, not just the DOM-rendered UI. The literals below are only fallbacks
// for when a property is somehow unset — theme.css always defines them.

function cssVar(name, fallback) {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

export const palette = {
  charcoal: {
    950: 'hsl(20, 16%, 6%)',
    900: 'hsl(20, 15%, 9%)',
    800: 'hsl(20, 13%, 13%)',
    700: 'hsl(18, 12%, 18%)',
    600: 'hsl(18, 10%, 25%)',
    500: 'hsl(18, 9%, 34%)',
    400: 'hsl(20, 8%, 48%)',
    300: 'hsl(22, 10%, 64%)',
    200: 'hsl(24, 14%, 80%)',
    100: 'hsl(28, 22%, 91%)',
    50: 'hsl(32, 30%, 97%)',
  },
  sun: {
    100: '#FFE8D1',
    200: '#FFD3AC',
    300: '#FFB37B',
    400: '#FF9B54',
    500: '#F0813A',
    600: '#E8763C',
    700: '#C85F2C',
    800: '#9C4A22',
    900: '#6B3218',
  },
  sky: {
    300: '#A8D8E8',
    400: '#7CC3DA',
    500: '#56ABC6',
    600: '#3E8CA8',
  },
  green: { 400: '#8ED191', 500: '#6FBF73', 600: '#4E9A52' },
  amber: { 400: '#F5C976', 500: '#F2B84B', 600: '#D89A2E' },
  red: { 400: '#F0958A', 500: '#E8776B', 600: '#CC5A4E' },
}

export const textOnAccent = '#1A0E06'

// Ambient background gradient, driven by system load (0-100ish). Base hue
// reads from --nimbus-gradient-hue (default 25, warm amber/brown) so an
// override can re-tint the ambient background on its own; as load rises the
// gradient both saturates and lightens slightly, reading as "warming up".
export function ambientGradient(load) {
  const baseHue = Number(cssVar('--nimbus-gradient-hue', '25')) || 25
  const hue = baseHue + load * 0.25
  const light = 7 + load * 0.05
  return `linear-gradient(145deg, hsl(${hue}, 55%, ${light}%) 0%, hsl(${hue + 8}, 45%, ${light + 7}%) 60%, hsl(${hue + 15}, 40%, ${light + 20}%) 100%)`
}

// xterm.js reads colors as a JS object at construction time; it does not see
// the page's CSS, so this must be called (not imported as a static value)
// after the page's stylesheets — including any override — have loaded.
export function getXtermTheme() {
  return {
    background: cssVar('--color-bg-canvas', palette.charcoal[950]),
    foreground: cssVar('--text-primary', 'rgba(255, 246, 238, 0.92)'),
    cursor: cssVar('--nimbus-sun-400', palette.sun[400]),
    cursorAccent: cssVar('--color-text-on-accent', textOnAccent),
    selectionBackground: cssVar('--color-accent-soft-border', 'rgba(240, 129, 58, 0.35)'),
    black: cssVar('--nimbus-charcoal-900', palette.charcoal[900]),
    brightBlack: cssVar('--nimbus-charcoal-600', palette.charcoal[600]),
    red: cssVar('--nimbus-red-500', palette.red[500]),
    brightRed: cssVar('--nimbus-red-400', palette.red[400]),
    green: cssVar('--nimbus-green-500', palette.green[500]),
    brightGreen: cssVar('--nimbus-green-400', palette.green[400]),
    yellow: cssVar('--nimbus-amber-500', palette.amber[500]),
    brightYellow: cssVar('--nimbus-amber-400', palette.amber[400]),
    blue: cssVar('--nimbus-sky-500', palette.sky[500]),
    brightBlue: cssVar('--nimbus-sky-400', palette.sky[400]),
    magenta: cssVar('--nimbus-sun-600', palette.sun[600]),
    brightMagenta: cssVar('--nimbus-sun-400', palette.sun[400]),
    cyan: cssVar('--nimbus-sky-400', palette.sky[400]),
    brightCyan: cssVar('--nimbus-sky-300', palette.sky[300]),
    white: cssVar('--nimbus-charcoal-100', palette.charcoal[100]),
    brightWhite: cssVar('--nimbus-charcoal-50', palette.charcoal[50]),
  }
}

// QRCode.toCanvas() colors for the kiosk "scan to connect" screen. Same
// call-time-not-import-time reasoning as getXtermTheme().
export function getQrColors() {
  return {
    dark: cssVar('--color-bg-canvas', palette.charcoal[950]),
    light: cssVar('--nimbus-charcoal-50', '#FFF6EE'),
  }
}
