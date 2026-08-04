// Ink iconography for the Rallypoint app chrome. Ported from the Planner design
// handoff (lib.jsx): a brand compass, a thin-stroke (1.5px) square icon set, and
// the brand lockup used as the app-switcher trigger. Custom-drawn — the repo
// ships no icon font — so they live here rather than pulling a dependency.
//
// Planner-specific content glyphs (the My Day progress Ring and the ticket QR
// stub) intentionally stay in apps/planner-web; only the chrome-shared set is
// promoted here.

import type { CSSProperties, JSX } from 'react'

// Brand compass; needle + bezel dot use the live accent (--acid).
export function Compass({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <circle cx="256" cy="256" r="200" stroke="currentColor" strokeWidth="16" fill="none" />
      <line x1="256" y1="40" x2="256" y2="74" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
      <line x1="256" y1="438" x2="256" y2="472" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
      <line x1="40" y1="256" x2="74" y2="256" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
      <line x1="438" y1="256" x2="472" y2="256" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
      <line x1="408.7" y1="103.3" x2="389.5" y2="122.5" stroke="currentColor" strokeWidth="11" strokeLinecap="round" opacity="0.55" />
      <line x1="103.3" y1="103.3" x2="122.5" y2="122.5" stroke="currentColor" strokeWidth="11" strokeLinecap="round" opacity="0.55" />
      <line x1="408.7" y1="408.7" x2="389.5" y2="389.5" stroke="currentColor" strokeWidth="11" strokeLinecap="round" opacity="0.55" />
      <line x1="103.3" y1="408.7" x2="122.5" y2="389.5" stroke="currentColor" strokeWidth="11" strokeLinecap="round" opacity="0.55" />
      <polygon points="343.1,168.9 183.73,258.41 253.59,328.27" fill="var(--acid)" />
      <circle cx="397.4" cy="114.6" r="24" fill="var(--acid)" />
      <circle cx="397.4" cy="114.6" r="10" fill="var(--bg)" />
    </svg>
  )
}

export type IconName =
  | 'myday'
  | 'upcoming'
  | 'tasks'
  | 'events'
  | 'check'
  | 'plus'
  | 'clock'
  | 'pin'
  | 'repeat'
  | 'bell'
  | 'file'
  | 'download'
  | 'grid'
  | 'money'
  | 'sliders'
  | 'chevron'
  | 'pencil'
  | 'more'
  | 'chat'
  | 'cart'
  | 'trash'
  | 'calendar'
  | 'gear'
  // Fitness glyphs — drawn to the same 16px / 1.5px spec as the chrome set.
  // Promoted from the prototype's FitIcon in the Fitness design handoff so the
  // four Fitness tabs and modality chips don't need an app-local icon set.
  | 'barbell'
  | 'flame'
  | 'stopwatch'
  | 'pause'
  | 'play'
  | 'run'
  | 'trophy'
  | 'heart'
  | 'ruler'
  | 'bolt'
  | 'star'
  | 'history'
  | 'bar-chart'
  | 'week-grid'
  // Food-logging glyphs (Fitness /food quick-add menu) — same 16px / 1.5px spec.
  | 'barcode'
  | 'camera'
  | 'cup'
  | 'search'
  // ── cmd-local additions (VENDORED.md ledger) ──────────────────────────────
  // Nav + action glyphs the panel needs that upstream's chrome set lacks.
  // Same 16×16 / 1.5px-stroke spec. Kept in one trailing block on both the
  // union and PATHS so a future `diff -u` against upstream is two clean hunks.
  | 'terminal'
  | 'users'
  | 'puzzle'
  | 'upload'
  | 'stop'

const PATHS: Record<IconName, JSX.Element> = {
  search: (
    <>
      <circle cx="6.8" cy="6.8" r="4.6" />
      <path d="M10.2 10.2L14 14" />
    </>
  ),
  myday: (
    <>
      <circle cx="8" cy="9" r="3.1" />
      <path d="M8 1.6v1.6M8 14.6v-.6M2 9H.6M15.4 9H14M3.5 4.5l-1-1M12.5 4.5l1-1M1.4 13h13.2" />
    </>
  ),
  upcoming: (
    <>
      <rect x="2" y="3" width="12" height="11" />
      <path d="M2 6.2h12M5.2 1.6v2.2M10.8 1.6v2.2" />
      <circle cx="8" cy="10" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  tasks: (
    <>
      <path d="M2 4.2h7M2 8h7M2 11.8h4.5" />
      <path d="M11 3.6l1.5 1.5L15 2.4" />
      <path d="M11.4 8.2h3M11.4 12h3" />
    </>
  ),
  events: (
    <>
      <path d="M2.5 4h11a0 0 0 0 1 0 0v2.2a1.4 1.4 0 0 0 0 2.8V11.8a0 0 0 0 1 0 0h-11a0 0 0 0 1 0 0V9a1.4 1.4 0 0 0 0-2.8V4z" />
      <path d="M9.5 4v7.8" strokeDasharray="1.4 1.4" />
    </>
  ),
  check: <path d="M2.5 8.5l3.2 3.2L13.5 4" strokeWidth="2" />,
  plus: <path d="M8 2.5v11M2.5 8h11" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.4V8l2.6 1.6" />
    </>
  ),
  pin: (
    <>
      <path d="M8 14.5s5-4.4 5-8a5 5 0 0 0-10 0c0 3.6 5 8 5 8z" />
      <circle cx="8" cy="6.5" r="1.8" />
    </>
  ),
  repeat: (
    <>
      <path d="M2.5 6.5A5 5 0 0 1 12 5.2l1.5 1.3" />
      <path d="M13.5 3v3.5H10" />
      <path d="M13.5 9.5A5 5 0 0 1 4 10.8L2.5 9.5" />
      <path d="M2.5 13V9.5H6" />
    </>
  ),
  bell: (
    <>
      <path d="M4 7a4 4 0 0 1 8 0c0 3 1.2 4 1.2 4H2.8S4 10 4 7z" />
      <path d="M6.6 13.4a1.6 1.6 0 0 0 2.8 0" />
    </>
  ),
  file: (
    <>
      <path d="M4 1.6h5L13 5.5V14.4H4z" />
      <path d="M9 1.6V5.5h4" />
    </>
  ),
  download: (
    <>
      <path d="M8 2.4v7.6M5 7.4L8 10.4l3-3" />
      <path d="M3 12.6h10" />
    </>
  ),
  grid: (
    <>
      <rect x="2.2" y="2.2" width="4.6" height="4.6" />
      <rect x="9.2" y="2.2" width="4.6" height="4.6" />
      <rect x="2.2" y="9.2" width="4.6" height="4.6" />
      <rect x="9.2" y="9.2" width="4.6" height="4.6" />
    </>
  ),
  money: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.4v7.2M9.8 6.1c-.4-.7-1.1-1-1.9-1-1 0-1.8.6-1.8 1.4 0 2 3.7 1 3.7 3 0 .9-.8 1.5-1.9 1.5-.9 0-1.6-.4-2-1.1" />
    </>
  ),
  sliders: (
    <>
      <path d="M2.5 5h7M11.5 5h2M2.5 11h2M6.5 11h7" />
      <circle cx="10" cy="5" r="1.5" />
      <circle cx="5" cy="11" r="1.5" />
    </>
  ),
  chevron: <path d="M6 3.5L10.5 8 6 12.5" />,
  pencil: (
    <>
      <path d="M2.8 13.2l.7-2.8L10.6 3.3l2.1 2.1-7.1 7.1-2.8.7z" />
      <path d="M9.3 4.6l2.1 2.1" />
    </>
  ),
  // Three-dot overflow / more-actions indicator.
  more: (
    <>
      <circle cx="4" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  // Chat bubble — rounded rect with a tail pointing down-left. Used by
  // the Events attendee chrome's Social tab (Rallypoint MVP kit).
  chat: (
    <>
      <path d="M2.4 3h11.2v8h-7l-3.2 2.6V11h-1V3z" />
      <circle cx="6" cy="7" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="7" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="11" cy="7" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
  // Shopping cart.
  cart: (
    <>
      <path d="M1.5 2h2l1.5 7h7l1.5-5H5" />
      <circle cx="7" cy="13" r="1" fill="currentColor" stroke="none" />
      <circle cx="11" cy="13" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  // Trash / delete.
  trash: (
    <>
      <path d="M2.5 4h11M6 4V2.6h4V4M4 4l.7 9.4a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4" />
      <path d="M6.6 6.8v4.6M9.4 6.8v4.6" />
    </>
  ),
  // Calendar / month page: framed grid with a header band, two binding posts,
  // and a row of day dots. Distinct from `upcoming` (single dot) and `grid`.
  calendar: (
    <>
      <rect x="2" y="3.5" width="12" height="10.5" />
      <path d="M2 7h12" />
      <path d="M5.5 1.6v2.8M10.5 1.6v2.8" />
      <circle cx="5.5" cy="10" r=".8" fill="currentColor" stroke="none" />
      <circle cx="8" cy="10" r=".8" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="10" r=".8" fill="currentColor" stroke="none" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.4v2.1M8 12.5v2.1M1.4 8h2.1M12.5 8h2.1M3.3 3.3l1.5 1.5M11.2 11.2l1.5 1.5M12.7 3.3l-1.5 1.5M4.8 11.2l-1.5 1.5" />
    </>
  ),
  barbell: <path d="M2 6v4M4 5v6M12 5v6M14 6v4M4 8h8" />,
  flame: <path d="M8 1.5s3.5 2.8 3.5 6a3.5 3.5 0 0 1-7 0c0-1 .5-2 .5-2s.6.8 1.3 1c-.3-2 1.7-3.6 1.7-5z" />,
  stopwatch: (
    <>
      <circle cx="8" cy="9" r="5.2" />
      <path d="M8 9V6M6.5 1.5h3M8 1.5v2.3" />
    </>
  ),
  pause: <path d="M5.5 3v10M10.5 3v10" />,
  play: <path d="M5 3l7 5-7 5V3z" />,
  run: (
    <>
      <circle cx="9.5" cy="3" r="1.3" />
      <path d="M8.5 6 6 7.5 7.5 10M8.5 6l2 1 1.5-.5M8.5 6 7 9.5l-2.5 3M10.5 7l.8 3 2.2.8" />
    </>
  ),
  trophy: <path d="M5 2h6v3a3 3 0 0 1-6 0V2zM5 3H3v1a2 2 0 0 0 2 2M11 3h2v1a2 2 0 0 1-2 2M6.5 8.5 6 11h4l-.5-2.5M4.5 13.5h7" />,
  heart: <path d="M8 13.5S2.5 10 2.5 6.2A2.7 2.7 0 0 1 8 5a2.7 2.7 0 0 1 5.5 1.2C13.5 10 8 13.5 8 13.5z" />,
  ruler: (
    <>
      <rect x="2" y="5" width="12" height="6" rx="0.5" />
      <path d="M5 5v2M8 5v2.5M11 5v2" />
    </>
  ),
  bolt: <path d="M9 1.5 3.5 8.5H7.5L6.5 14.5 12.5 7H8.5L9 1.5z" />,
  star: <path d="M8 1.8l1.7 3.9 4.2.4-3.2 2.8 1 4.1L8 11l-3.7 2 1-4.1-3.2-2.8 4.2-.4L8 1.8z" />,
  history: (
    <>
      <path d="M8 3.4a4.6 4.6 0 1 1-4.4 3.3" />
      <path d="M3.1 3v2.5h2.5" />
      <path d="M8 5.6V8l1.7 1" />
    </>
  ),
  // Compact bar-chart for the Stats tab (Training default).
  'bar-chart': <path d="M2 13.5V2.5M2 13.5h12M5 11V8M8 11V5M11 11V9" />,
  // Weekly grid for the Plan tab — frame + day columns.
  'week-grid': (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1" />
      <path d="M2 6h12M6 6v7.5M10 6v7.5" />
    </>
  ),
  // UPC stripes of varied heights.
  barcode: <path d="M2 3.5v9M4.5 3.5v9M7 3.5v6.5M9.5 3.5v9M12 3.5v6.5M14 3.5v9" />,
  // Body + top bump + lens.
  camera: (
    <>
      <path d="M1.5 5.5h2.5l1.2-1.8h5.6l1.2 1.8h2.5v8h-13v-8z" />
      <circle cx="8" cy="9.2" r="2.4" />
    </>
  ),
  // Tapered tumbler with a fill line.
  cup: (
    <>
      <path d="M4 2.5h8l-1 11H5l-1-11z" />
      <path d="M4.4 6.5h7.2" />
    </>
  ),
  // ── cmd-local additions (VENDORED.md ledger) ──────────────────────────────
  // Window with a shell prompt caret + cursor line.
  terminal: (
    <>
      <rect x="2" y="2.8" width="12" height="10.4" rx="1.4" />
      <path d="M4.8 6.4 7 8.4l-2.2 2" />
      <path d="M8.6 10.6h3" />
    </>
  ),
  // Two heads + shoulders, the trailing one behind.
  users: (
    <>
      <circle cx="6.2" cy="5.4" r="2.4" />
      <path d="M2 13.4c0-2.3 1.9-3.8 4.2-3.8s4.2 1.5 4.2 3.8" />
      <path d="M10.6 3.3a2.4 2.4 0 0 1 0 4.2" />
      <path d="M11.4 9.9c1.6.4 2.6 1.7 2.6 3.5" />
    </>
  ),
  // Jigsaw piece with a knob on the right edge.
  puzzle: (
    <>
      <path d="M2.6 2.6h4v1a1.4 1.4 0 0 0 2.8 0v-1h4v4h-1a1.4 1.4 0 0 0 0 2.8h1v4h-4v-1a1.4 1.4 0 0 0-2.8 0v1h-4v-4" />
      <path d="M2.6 9.4h1a1.4 1.4 0 0 0 0-2.8h-1v-4" />
    </>
  ),
  // Mirror of `download` — arrow out of the baseline.
  upload: (
    <>
      <path d="M8 10.4V2.8M5 5.8 8 2.8l3 3" />
      <path d="M3 12.6h10" />
    </>
  ),
  // Filled square. `pause` would misread as "hold", not "shut down".
  stop: <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />,
}

export function Icon({
  name,
  size = 16,
  stroke = 1.5,
}: {
  name: IconName
  size?: number
  stroke?: number
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: `0 0 ${size}px` }}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

// Brand lockup: compass + two-tone "rallypt" wordmark + optional caret. Used as
// the app-switcher trigger contents. (Distinct from the older minimalist
// `BrandLockup` wordmark in this package — this is the Ink chrome lockup.)
export function AppBrandLockup({
  size = 'desktop',
  caret,
  caretOpen = false,
}: {
  size?: 'desktop' | 'mobile'
  caret?: boolean
  caretOpen?: boolean
}) {
  const cw = size === 'desktop' ? 40 : 28
  const fs = size === 'desktop' ? 30 : 22
  const caretStyle: CSSProperties = {
    color: 'var(--ink-mute)',
    display: 'flex',
    transition: 'transform .15s ease',
    transform: caretOpen ? 'rotate(180deg)' : 'none',
  }
  return (
    <>
      <span style={{ color: 'var(--ink)', display: 'flex' }}>
        <Compass size={cw} />
      </span>
      <span className="pl-wordmark" style={{ fontSize: fs }}>
        rally<b>pt</b>
      </span>
      {caret && (
        <span style={caretStyle}>
          <Icon name="chevron" size={12} />
        </span>
      )}
    </>
  )
}
