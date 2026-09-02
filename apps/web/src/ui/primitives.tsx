import { Children, cloneElement, useId, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react'

// Small set of styled primitives so every page looks like one system.
// Built on the vendored Ink recipes (.pl-card / .pl-btn / .pl-chip /
// .pl-input) plus the panel-specific ones in cmd.css.
//
// The exported API is deliberately unchanged from the pre-Ink version —
// same names, same props — so the routes keep compiling while they are
// swept one at a time. Two additive options were needed (Card `size`,
// Button `size`); nothing was removed.

export function Card({
  title,
  actions,
  size = 'eyebrow',
  children,
  className = '',
}: {
  title?: ReactNode
  actions?: ReactNode
  /**
   * `eyebrow` (default) heads the card with the Ink mono-caps section
   * rule. `title` uses the display face at 20px — for the few cards
   * whose heading is the page's main message rather than a label.
   */
  size?: 'eyebrow' | 'title'
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`pl-card ${className}`}>
      {(title || actions) && (
        <header className="cmd-card-head">
          {size === 'title' ? (
            <h2 className="display cmd-card-title">{title}</h2>
          ) : (
            <>
              <h2 className="eyebrow">{title}</h2>
              <span className="ln" />
            </>
          )}
          {actions}
        </header>
      )}
      <div className="cmd-card-body">{children}</div>
    </section>
  )
}

type Variant = 'primary' | 'ghost' | 'danger' | 'warn'
// `primary` is the bare .pl-btn (solid accent + glow); the rest are its
// modifiers. `warn` has no Ink equivalent — see cmd.css.
const VARIANTS: Record<Variant, string> = {
  primary: '',
  ghost: 'ghost',
  danger: 'hot',
  warn: 'warn',
}

export function Button({
  variant = 'ghost',
  size,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' }) {
  // No `type` default on purpose: five of the panel's forms (Login,
  // Console broadcast, Players broadcast, Schedules create, Account
  // password) rely on the implicit submit. Defaulting to "button" would
  // silently turn them all into no-ops.
  return (
    <button
      className={`pl-btn ${VARIANTS[variant]} ${size === 'sm' ? 'sm' : ''} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function Badge({
  tone,
  children,
}: {
  tone: 'good' | 'bad' | 'warn' | 'muted'
  children: ReactNode
}) {
  const tones = { good: 'ok', bad: 'bad', warn: 'warn', muted: '' }
  return <span className={`pl-chip ${tones[tone]}`}>{children}</span>
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="cmd-stat">
      <div className="eyebrow">{label}</div>
      <div className="display cmd-stat-value">{value}</div>
      {sub && <div className="meta cmd-stat-sub">{sub}</div>}
    </div>
  )
}

// The label is a SIBLING of its control, associated by id — never wrap
// the control in the <label>. A wrapping label re-dispatches its click
// into the control, which is how a native <select> picker in desktop
// Chrome/Edge opened and closed on the same click. `getByLabel` in the
// e2e suite resolves htmlFor associations exactly like wrapping did.
// `children` must be the single control element; it receives the id.
export function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId()
  return (
    <div className="block">
      <label htmlFor={id} className="eyebrow mb-1.5 block">
        {label}
      </label>
      {cloneElement(Children.only(children), { id })}
    </div>
  )
}

export const inputClass = 'pl-input'

export function Spinner() {
  return (
    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--line)] border-t-[var(--acid)]" />
  )
}
