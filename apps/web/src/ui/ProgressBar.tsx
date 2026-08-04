import type { ReactNode } from 'react'

// Determinate / indeterminate progress, wrapping Ink's `.progress`
// primitive. Replaces four hand-rolled copies (disk usage, backup op,
// restore op, SteamCMD update).
//
// `value == null` means indeterminate — the panel genuinely has ops that
// report no percentage until they finish.

export function ProgressBar({
  value,
  tone = 'accent',
  size = 'lg',
  label,
  right,
}: {
  /** 0-100, or null/undefined for indeterminate. */
  value?: number | null
  tone?: 'accent' | 'ok' | 'warn' | 'bad'
  /** Ink's `.progress` is 4px; `lg` is the 8px bar the panel used. */
  size?: 'sm' | 'lg'
  label?: ReactNode
  right?: ReactNode
}) {
  const indeterminate = value == null
  return (
    <div>
      {(label || right) && (
        <div className="cmd-progress-head">
          <span>{label}</span>
          <span>{right}</span>
        </div>
      )}
      <div
        className={`progress ${size === 'lg' ? 'lg' : ''} ${tone}`}
        role="progressbar"
        {...(indeterminate
          ? {}
          : { 'aria-valuenow': Math.round(value), 'aria-valuemin': 0, 'aria-valuemax': 100 })}
      >
        <div
          className={indeterminate ? 'is-indeterminate' : ''}
          style={indeterminate ? undefined : { width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
    </div>
  )
}
