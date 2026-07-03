// The Nimbus logomark — a simple geometric cloud, replacing the previous
// plain-text "☁" emoji used as the in-app logo. Same shape as public/favicon.svg,
// as an inline component so it can be sized/tinted with the rest of the UI.
export default function NimbusMark({ size = 28, background = true }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      {background && <rect width="100" height="100" rx="22" fill="var(--nimbus-charcoal-800)" />}
      <path
        d="M32 66c-8 0-14-6-14-13s6-13 13-13c1-9 9-16 19-16 9 0 17 6 19 15 7 1 12 7 12 14 0 8-6 13-14 13H32z"
        fill="var(--color-accent)"
      />
    </svg>
  )
}
