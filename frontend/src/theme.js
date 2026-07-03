// JS mirror of theme.css's primitive values, for the few places CSS variables
// can't reach: canvas/WebGL-rendered text (xterm.js), <canvas> drawing (QR code),
// and inline gradient math. Keep these two files in sync by hand — there is no
// build step that generates one from the other.

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

// Ambient background gradient, driven by system load (0-100ish).
// Base hue sits in the warm amber/brown range (~25) instead of the old blue (~210);
// as load rises the gradient both saturates and lightens slightly, reading as
// "warming up" rather than the old "stormy -> clear sky" blue metaphor.
export function ambientGradient(load) {
  const hue = 25 + load * 0.25
  const light = 7 + load * 0.05
  return `linear-gradient(145deg, hsl(${hue}, 55%, ${light}%) 0%, hsl(${hue + 8}, 45%, ${light + 7}%) 60%, hsl(${hue + 15}, 40%, ${light + 20}%) 100%)`
}

// xterm.js reads colors as a JS object at construction time; it does not see the page's CSS.
export const xtermTheme = {
  background: palette.charcoal[950],
  foreground: 'rgba(255, 246, 238, 0.92)',
  cursor: palette.sun[400],
  cursorAccent: textOnAccent,
  selectionBackground: 'rgba(240, 129, 58, 0.35)',
  black: palette.charcoal[900],
  brightBlack: palette.charcoal[600],
  red: palette.red[500],
  brightRed: palette.red[400],
  green: palette.green[500],
  brightGreen: palette.green[400],
  yellow: palette.amber[500],
  brightYellow: palette.amber[400],
  blue: palette.sky[500],
  brightBlue: palette.sky[400],
  magenta: palette.sun[600],
  brightMagenta: palette.sun[400],
  cyan: palette.sky[400],
  brightCyan: palette.sky[300],
  white: palette.charcoal[100],
  brightWhite: palette.charcoal[50],
}

// QRCode.toCanvas() colors for the kiosk "scan to connect" screen.
export const qrColors = {
  dark: palette.charcoal[950],
  light: '#FFF6EE',
}
