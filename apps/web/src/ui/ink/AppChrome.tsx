import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { NavLink } from 'react-router-dom'
import { Icon, type IconName } from './icons.js'

// Rallypoint "Ink" app chrome — the shared shell promoted from planner-web.
// Desktop: a 220px sidebar (≥1024px). Mobile: a 52px top bar + bottom pill
// tab-bar. The brand lockup and the user menu are injected via render-prop
// slots so each app supplies its own session-aware controls; an optional FAB
// slot and an internal toast complete the chrome. The app passes its own `nav`
// config and `subLabel`.
//
// VENDORED from @rallypoint/ui — see ./VENDORED.md. Two ledger edits:
//
//   1. Upstream's touch swipe-between-tabs navigation (and its `swipe-nav`
//      dependency, plus the `activeIndex` computation that only fed it) is
//      REMOVED. On an ops console a stray horizontal drag across a scrolling
//      log pane or a wide table would navigate away mid-incident; upstream
//      tunes around that with per-surface `data-noswipe` exclusions, which is
//      a maintenance burden this eight-item nav does not earn.
//   2. `AppChromeNavItem.badge` is ADDED — the panel flags an available
//      self-update on the Updates tab. Render `aria-hidden` content only; a
//      badge visible to assistive tech would join the link's accessible name
//      and break `getByRole('link', { name: 'Updates' })`.

export interface AppChromeNavItem {
  to: string
  label: string
  icon: IconName
  /** Match the route exactly (passed through to NavLink `end`). */
  end?: boolean
  /** Optional decoration (e.g. an update dot). Must be `aria-hidden`. */
  badge?: ReactNode
}

export interface AppChromeProps {
  nav: readonly AppChromeNavItem[]
  /** App name shown under the brand lockup (e.g. "Planner", "Lists"). */
  subLabel: string
  /** Brand slot, rendered in both sidebar (desktop) and top bar (mobile). */
  brand?: (ctx: { size: 'desktop' | 'mobile'; showToast: (msg: string) => void }) => ReactNode
  /** User-menu slot, rendered in both sidebar (desktop) and top bar (mobile). */
  userMenu?: (ctx: { size: 'desktop' | 'mobile' }) => ReactNode
  /** Optional action button rendered immediately to the left of the avatar —
   *  in the mobile top bar and the desktop sidebar foot. */
  topAction?: (ctx: { size: 'desktop' | 'mobile' }) => ReactNode
  /** Optional floating action button. */
  fab?: (ctx: { showToast: (msg: string) => void }) => ReactNode
  // Forwarded ref onto the scroll container `<main class="plapp-main">`.
  mainRef?: Ref<HTMLElement>
  // Sibling content rendered inside `.plapp-main` above `children`.
  mainOverlay?: ReactNode
  children: ReactNode
}

// ── Shared NavItem ────────────────────────────────────────────────────────────
// Renders the inner content of a nav link/tab pill. Used by both the desktop
// sidebar and the mobile tab bar so the two surfaces can't drift.

interface NavItemContentProps {
  def: AppChromeNavItem
  variant: 'sidebar' | 'tabbar'
}

function NavItemContent({ def, variant }: NavItemContentProps) {
  if (variant === 'sidebar') {
    return (
      <>
        <span className="ic">
          <Icon name={def.icon} size={16} />
        </span>
        {def.label}
        {def.badge}
      </>
    )
  }
  // tabbar: icon above label
  return (
    <>
      <span className="pl-tab-icon" aria-hidden="true">
        <Icon name={def.icon} size={18} />
        {def.badge}
      </span>
      <span className="pl-tab-label">{def.label}</span>
    </>
  )
}

export function AppChrome({ nav, subLabel, brand, userMenu, topAction, fab, mainRef, mainOverlay, children }: AppChromeProps) {
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function showToast(msg: string) {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2400)
  }

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
  }, [])

  return (
    <div className="plapp">
      <aside className="pl-side">
        <div className="pl-brand">
          {brand?.({ size: 'desktop', showToast })}
          <div className="pl-sub">{subLabel}</div>
        </div>
        <nav className="pl-nav" aria-label="Primary navigation">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end ?? false}
              className={({ isActive }) => 'pl-navlink' + (isActive ? ' is-active' : '')}
            >
              <NavItemContent def={n} variant="sidebar" />
            </NavLink>
          ))}
        </nav>
        {(userMenu || topAction) && (
          <div className="pl-side-foot">
            {topAction?.({ size: 'desktop' })}
            {userMenu?.({ size: 'desktop' })}
          </div>
        )}
      </aside>

      <div className="plapp-body">
        {(brand || userMenu || topAction) && (
          <div className="pl-topbar">
            {brand?.({ size: 'mobile', showToast })}
            {(topAction || userMenu) && (
              <div className="pl-topbar-trail">
                {topAction?.({ size: 'mobile' })}
                {userMenu?.({ size: 'mobile' })}
              </div>
            )}
          </div>
        )}

        <main
          className="plapp-main"
          ref={mainRef}
          style={mainOverlay ? { position: 'relative' } : undefined}
        >
          {mainOverlay}
          <div className="plapp-content">{children}</div>
        </main>

        {nav.length > 0 && (
          <nav className="pl-tabbar" aria-label="App navigation">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end ?? false}
                className={({ isActive }) => 'pl-tab' + (isActive ? ' is-active' : '')}
              >
                <NavItemContent def={n} variant="tabbar" />
              </NavLink>
            ))}
          </nav>
        )}
      </div>

      {fab?.({ showToast })}

      {toast && <div className="pl-toast" role="status">{toast}</div>}
    </div>
  )
}
