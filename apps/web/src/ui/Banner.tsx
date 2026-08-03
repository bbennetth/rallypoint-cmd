import type { ReactNode } from 'react'

// Inline status banner — the panel's pendingRestart / restart-needed /
// error / success notices, which were four copies of the same
// `rounded-lg border border-panel-{tone}/40 bg-panel-{tone}/10` markup.
//
// Not ported from @rallypoint/ui's Banner: that one draws a hard 1.5px
// border (contrary to Soft Ink) and has no actions slot, which two of
// the four call sites need. The tone-to-role mapping is upstream's.

export type BannerTone = 'info' | 'ok' | 'warn' | 'bad'

export function Banner({
  tone = 'info',
  actions,
  children,
}: {
  tone?: BannerTone
  /** Trailing control, e.g. the "Restart now" button. */
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={`cmd-banner ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <div className="cmd-banner-text">{children}</div>
      {actions}
    </div>
  )
}
