import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { nextFocusAfterTrap } from './ink/focus-trap.js'

// Modal dialog. The panel had exactly one modal — the restore confirm —
// as a raw fixed overlay with no focus trap, no portal and no Escape
// handling, plus three native confirm() calls for destructive actions.
//
// Structure follows @rallypoint/ui's ConfirmDialog (labelled title/body
// ids, rAF initial focus, focus restored to the opener on close, Tab
// wrapping via the vendored focus-trap helper), but takes a children
// slot instead of fixed title/body/buttons: the restore dialog needs a
// <dl>, a mismatch warning and a type-to-confirm input.
//
// Two deliberate departures from upstream:
//   - createPortal to <body>, so the scrim covers the sidebar and the
//     tab bar and no future transformed ancestor can trap it.
//   - The scrim is a chassis-tinted blur rather than black/60, which
//     reads as a hole punched in the page against the navy chassis.

export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 520,
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<Element | null>(null)
  const titleId = useId()

  useEffect(() => {
    openerRef.current = document.activeElement
    // Focus synchronously rather than inside a requestAnimationFrame.
    // createPortal has already committed the panel to the DOM by the time
    // effects run, so there is nothing to wait for — and rAF callbacks do
    // not fire at all in a tab the browser is not compositing (a
    // background tab, or a hidden embedded view), which would strand
    // keyboard users outside the modal exactly where it matters most.
    const panel = panelRef.current
    if (panel) (nextFocusAfterTrap(panel, null, 'forward') ?? panel).focus()
    return () => {
      // Restore focus to whatever opened us, so keyboard users are not
      // dumped back at the top of the document.
      if (openerRef.current instanceof HTMLElement) openerRef.current.focus()
    }
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const next = nextFocusAfterTrap(
        panel,
        document.activeElement,
        e.shiftKey ? 'backward' : 'forward',
      )
      e.preventDefault()
      ;(next ?? panel).focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  return createPortal(
    <div className="cmd-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className="pl-card cmd-dialog"
        style={{ maxWidth: width }}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="cmd-card-head">
          <h2 className="eyebrow" id={titleId}>
            {title}
          </h2>
          <span className="ln" />
        </div>
        <div className="cmd-card-body">{children}</div>
        {footer && <div className="cmd-dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
