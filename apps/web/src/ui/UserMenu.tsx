import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

// Signed-in user fly-out for the app chrome: a `.pl-avatar` trigger opening a
// menu with Account and Sign out. Rendered by AppChrome into the desktop
// sidebar foot and the mobile top bar, so `/account` is reachable from both
// (it is not in the nav).
//
// Ported and trimmed from @rallypoint/ui's UserMenu — the dismissal and focus
// behaviour is the part worth keeping rather than re-deriving: outside-click
// closes without stealing focus from the click target, Escape closes AND
// returns focus to the trigger (the ARIA menu pattern), the first item takes
// focus on open, and Arrow/Home/End rove within the menu.
//
// Trimmed: upstream's `Avatar` (the panel's session carries only a username,
// so initials are inline) and `accountUrl` (upstream deep-links to id-web's
// hosted account page in a new tab; the panel routes in-app).

export interface UserMenuProps {
  username: string | null
  size?: 'desktop' | 'mobile'
  onAccount: () => void
  onSignout: () => void | Promise<void>
}

function initials(username: string | null): string {
  const name = username?.trim()
  if (!name) return '??'
  return name.slice(0, 2).toUpperCase()
}

export function UserMenu({ username, size = 'desktop', onAccount, onSignout }: UserMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const flyoutRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', off)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  // Focus the first menuitem when the flyout opens.
  useEffect(() => {
    if (!open || !flyoutRef.current) return
    flyoutRef.current.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open])

  function onFlyoutKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!flyoutRef.current) return
    const items = Array.from(
      flyoutRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).filter((n) => !n.hasAttribute('disabled'))
    const active = document.activeElement as HTMLElement | null
    const idx = active ? items.indexOf(active) : -1

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(idx + 1) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(idx - 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1]?.focus()
    }
  }

  return (
    <div className="pl-switch" ref={ref}>
      <button
        type="button"
        ref={triggerRef}
        className="pl-user-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-label="Account menu"
        aria-expanded={open}
        aria-haspopup="menu"
        style={
          size === 'desktop'
            ? { display: 'flex', alignItems: 'center', gap: 10, width: '100%', minWidth: 0 }
            : undefined
        }
      >
        <span className="pl-avatar" aria-hidden="true">
          {initials(username)}
        </span>
        {size === 'desktop' && (
          <span style={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
            <span
              style={{
                display: 'block',
                fontSize: 12.5,
                color: 'var(--ink)',
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {username ?? 'Signed in'}
            </span>
            <span className="eyebrow" style={{ display: 'block', marginTop: 2 }}>
              Signed in
            </span>
          </span>
        )}
      </button>
      {open && (
        <div
          ref={flyoutRef}
          className={'pl-flyout' + (size === 'desktop' ? ' is-up' : ' is-right')}
          role="menu"
          onKeyDown={onFlyoutKeyDown}
        >
          <div style={{ display: 'grid', gap: 6 }}>
            <button
              type="button"
              role="menuitem"
              className="pl-shortcut"
              onClick={() => {
                setOpen(false)
                onAccount()
              }}
            >
              Account
            </button>
            <button
              type="button"
              role="menuitem"
              className="pl-shortcut"
              onClick={() => {
                setOpen(false)
                void onSignout()
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
