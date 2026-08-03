import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

// Monospace log viewer — the console stream, the SteamCMD output, the
// dashboard's two inline tails and the release notes were four copies of
// `thin-scroll overflow-auto rounded-lg bg-black/40 p-3` wrapping a
// `<pre className="mono …">`.
//
// No Ink equivalent to port. Notably this is what retires the hardcoded
// `bg-black/40`: the pane now sits on `--surface-sunken`, Ink's own alias
// for "this is a sunken surface", so it tracks the chassis.

export function LogPane({
  lines,
  empty = 'Nothing yet…',
  maxHeight,
  fill = false,
  autoscroll = false,
  errorPattern,
}: {
  /** Pre-split lines, or a ready-made blob. */
  lines: readonly string[] | string
  empty?: ReactNode
  /** Cap the height in px. Ignored when `fill` is set. */
  maxHeight?: number
  /** Grow to fill a flex parent (the Console viewer) instead of capping. */
  fill?: boolean
  autoscroll?: boolean
  /** Lines matching this are tinted with the danger colour. */
  errorPattern?: RegExp
}) {
  const paneRef = useRef<HTMLDivElement>(null)
  const arr = typeof lines === 'string' ? (lines ? lines.split('\n') : []) : lines

  useEffect(() => {
    if (!autoscroll) return
    const pane = paneRef.current
    if (!pane) return
    // Set scrollTop directly rather than scrollIntoView on a bottom
    // marker: scrollIntoView walks up and scrolls EVERY scrollable
    // ancestor, so on a page whose log pane is nested in the app's own
    // scroll container it drags the page header out of view too.
    pane.scrollTop = pane.scrollHeight
  }, [arr, autoscroll])

  return (
    <div
      ref={paneRef}
      className={`cmd-log thin-scroll ${fill ? 'is-fill' : ''}`}
      style={!fill && maxHeight != null ? { maxHeight } : undefined}
    >
      {arr.length === 0 ? (
        <p className="cmd-log-empty">{empty}</p>
      ) : errorPattern ? (
        arr.map((l, i) => (
          <pre key={i} className={errorPattern.test(l) ? 'err' : undefined}>
            {l}
          </pre>
        ))
      ) : (
        <pre>{arr.join('\n')}</pre>
      )}
    </div>
  )
}
