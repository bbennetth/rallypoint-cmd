import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
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

function navItems(updateAvailable: boolean): readonly AppChromeNavItem[] {
  // `aria-hidden` and no text: a badge visible to assistive tech would join
  // the link's accessible name and break `getByRole('link', {name:'Updates'})`.
  const dot: ReactNode = updateAvailable ? (
    <span className="pl-navdot" aria-hidden="true" />
  ) : null

  return [
    { to: '/', label: 'Dashboard', icon: 'grid', end: true },
    { to: '/console', label: 'Console', icon: 'terminal' },
    { to: '/players', label: 'Players', icon: 'users' },
    { to: '/settings', label: 'Settings', icon: 'sliders' },
    { to: '/updates', label: 'Updates', icon: 'download', ...(dot ? { badge: dot } : {}) },
    { to: '/mods', label: 'Mods', icon: 'puzzle' },
    { to: '/backups', label: 'Backups', icon: 'file' },
    { to: '/schedules', label: 'Schedules', icon: 'clock' },
  ]
}

export function AppChrome({ children }: { children: ReactNode }) {
  const { session, logout } = useAuth()
  const navigate = useNavigate()
  // Daily update check (server-side cached): dots the Updates nav item when a
  // newer release exists. Best-effort only.
  const [updateAvailable, setUpdateAvailable] = useState(false)
  useEffect(() => {
    api
      .panelUpdate(false)
      .then((info) => setUpdateAvailable(info.updateAvailable))
      .catch(() => {})
  }, [])

  return (
    <InkAppChrome
      nav={navItems(updateAvailable)}
      subLabel="CMD"
      brand={({ size }) => (
        // AppBrandLockup is a bare fragment (compass span + wordmark span)
        // that relies on its parent being a flex row — upstream only ever
        // renders it inside `.pl-switch-trigger`. Without this wrapper the
        // sidebar stacks the two (its container is a plain block) and the
        // mobile top bar's `space-between` shoves them to opposite ends.
        <div className="cmd-brand">
          <AppBrandLockup size={size} />
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
