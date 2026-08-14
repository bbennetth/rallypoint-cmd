import { useEffect, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { GAMES, type GameDef } from '@rallypoint-cmd/shared'
import { AppChrome as InkAppChrome, type AppChromeNavItem } from './ink/AppChrome.js'
import { AppBrandLockup } from './ink/icons.js'
import { UserMenu } from './UserMenu.js'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'

// The panel's app chrome: the vendored Ink shell wired to this app's nav,
// session and update check. Desktop gets a 220px sidebar, mobile a top bar
// plus the floating pill tab-bar.
//
// Icon choices where the vendored set had no exact match: `grid` for the
// dashboard (four tiles), `sliders` for Settings (a settings *form* is knobs,
// not a gear), `file` for Backups (they are literally .tar.gz files) and
// `clock` for Schedules (cron). `terminal`, `users` and `puzzle` are the
// cmd-local glyphs added to ui/ink/icons.tsx.
//
// Eight tabs trips shell.css's `:has(> .pl-tab:nth-child(7))` rule, so the
// mobile pill sizes tabs to their content and scrolls horizontally rather
// than squeezing eight unreadable slivers into one screen width.

function navItems(
  updateAvailable: boolean,
  serverId: string | null,
  game: GameDef | undefined,
): readonly AppChromeNavItem[] {
  // `aria-hidden` and no text: a badge visible to assistive tech would join
  // the link's accessible name and break `getByRole('link', {name:'Updates'})`.
  const dot: ReactNode = updateAvailable ? (
    <span className="pl-navdot" aria-hidden="true" />
  ) : null

  // Outside a server (the server-list home) the nav is just Servers.
  if (!serverId) {
    return [{ to: '/', label: 'Servers', icon: 'grid', end: true }]
  }

  // Inside a server: capability-gated per the game registry entry.
  const base = `/servers/${serverId}`
  const caps = game?.capabilities
  return [
    { to: '/', label: 'Servers', icon: 'grid', end: true },
    { to: base, label: 'Dashboard', icon: 'grid', end: true },
    { to: `${base}/console`, label: 'Console', icon: 'terminal' },
    ...(caps && caps.query !== 'none'
      ? [{ to: `${base}/players`, label: 'Players', icon: 'users' } as const]
      : []),
    ...(game && game.settingsAdapter !== 'none'
      ? [{ to: `${base}/settings`, label: 'Settings', icon: 'sliders' } as const]
      : []),
    { to: `${base}/updates`, label: 'Updates', icon: 'download', ...(dot ? { badge: dot } : {}) },
    ...(caps && caps.mods !== 'none'
      ? [{ to: `${base}/mods`, label: 'Mods', icon: 'puzzle' } as const]
      : []),
    ...(caps?.world
      ? [{ to: `${base}/backups`, label: 'Backups', icon: 'file' } as const]
      : []),
    { to: `${base}/schedules`, label: 'Schedules', icon: 'clock' },
  ]
}

export function AppChrome({ children }: { children: ReactNode }) {
  const { session, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  // Daily update check (server-side cached): dots the Updates nav item when a
  // newer release exists. Best-effort only.
  const [updateAvailable, setUpdateAvailable] = useState(false)
  useEffect(() => {
    api
      .panelUpdate(false)
      .then((info) => setUpdateAvailable(info.updateAvailable))
      .catch(() => {})
  }, [])

  // Current server (from the URL) + its game slug (fetched once) drive
  // the capability-gated nav.
  const serverId = location.pathname.match(/^\/servers\/([a-z0-9-]+)/)?.[1] ?? null
  const [slugById, setSlugById] = useState<Record<string, string>>({})
  useEffect(() => {
    api
      .servers()
      .then((r) => setSlugById(Object.fromEntries(r.servers.map((s) => [s.id, s.gameSlug]))))
      .catch(() => {})
  }, [serverId])
  const game = serverId ? GAMES[slugById[serverId] ?? ''] : undefined

  return (
    <InkAppChrome
      nav={navItems(updateAvailable, serverId, game)}
      brand={({ size }) => (
        // AppBrandLockup is a bare fragment (compass span + wordmark span)
        // that relies on its parent laying it out — upstream only ever
        // renders it inside `.pl-switch-trigger`, a flex row. `.cmd-brand`
        // is a 2-col grid so the desktop sublabel can sit in row 2 under
        // the wordmark column, right edge flush with the wordmark (which
        // the vendored `.pl-sub` cannot do — it spans the whole sidebar).
        // The blue c/m/d echo the wordmark's two-tone `pt`; aria-hidden so
        // the decorated string stays out of the accessible name.
        <div className="cmd-brand">
          <AppBrandLockup size={size} />
          {size === 'desktop' && (
            <span className="cmd-brand-sub" aria-hidden="true">
              <b>c</b>o<b>m</b>man<b>d</b>
            </span>
          )}
        </div>
      )}
      userMenu={({ size }) => (
        <UserMenu
          username={session?.username ?? null}
          size={size}
          onAccount={() => navigate('/account')}
          onSignout={async () => {
            await logout()
            navigate('/login')
          }}
        />
      )}
    >
      {children}
    </InkAppChrome>
  )
}
