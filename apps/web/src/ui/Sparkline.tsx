import { useId } from 'react'

// Minimal time-series chart for the Monitoring page. Hand-rolled rather
// than pulled from a chart library: one polyline and an area fill is the
// whole requirement, and the panel ships no charting dependency.
//
// Two behaviours are the reason this isn't three lines of `<polyline>`:
//
//  - Nulls are GAPS, not zeros. A stopped server, an unanswered query
//    and a first-tick CPU sample all arrive as null; drawing them at the
//    baseline would invent a "load dropped to nothing" story. Runs of
//    real values are drawn as separate segments instead.
//  - The viewBox is stretched to the container (`preserveAspectRatio:
//    none`), so stroke width is set in the *unstretched* user space and
//    would smear. `vector-effect: non-scaling-stroke` keeps it 1.5px
//    however wide the card gets.

const VIEW_W = 240
const TONES = {
  accent: 'var(--acid)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  bad: 'var(--bad)',
} as const

export type SparklineTone = keyof typeof TONES

export function Sparkline({
  points,
  max,
  tone = 'accent',
  height = 56,
  label,
}: {
  /** Oldest → newest. Nulls render as gaps. */
  points: readonly (number | null)[]
  /**
   * Upper bound of the y-axis. Defaults to the largest value present, so
   * a flat series still shows its shape. Pass an explicit ceiling (100
   * for a percentage, MemoryHigh for bytes) when the scale is meaningful
   * — otherwise a chart of 2% CPU looks identical to one of 90%.
   */
  max?: number | undefined
  tone?: SparklineTone | undefined
  height?: number | undefined
  /** Accessible description; the SVG is otherwise decorative. */
  label?: string | undefined
}) {
  const gradientId = useId()
  const values = points.filter((p): p is number => p !== null)
  const peak = max ?? Math.max(...values, 1)
  const ceiling = peak > 0 ? peak : 1
  const color = TONES[tone]

  // A single point has no line to draw; the stat tile above already
  // carries the number, so an empty frame is the honest rendering.
  if (values.length < 2) {
    return (
      <div className="cmd-spark" style={{ height }}>
        <span className="cmd-spark-empty">Not enough data yet</span>
      </div>
    )
  }

  const x = (i: number): number => (points.length === 1 ? 0 : (i / (points.length - 1)) * VIEW_W)
  const y = (v: number): number => {
    const clamped = Math.max(0, Math.min(ceiling, v))
    return height - (clamped / ceiling) * height
  }

  // Split into runs of consecutive non-null samples.
  const segments: { i: number; v: number }[][] = []
  let run: { i: number; v: number }[] = []
  points.forEach((v, i) => {
    if (v === null) {
      if (run.length > 0) segments.push(run)
      run = []
    } else {
      run.push({ i, v })
    }
  })
  if (run.length > 0) segments.push(run)

  return (
    <svg
      className="cmd-spark"
      viewBox={`0 0 ${VIEW_W} ${height}`}
      preserveAspectRatio="none"
      style={{ height }}
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {segments.map((seg, si) => {
        const line = seg.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')
        const area = `${x(seg[0]!.i)},${height} ${line} ${x(seg[seg.length - 1]!.i)},${height}`
        return (
          <g key={si}>
            {seg.length > 1 && <polygon points={area} fill={`url(#${gradientId})`} />}
            <polyline
              points={line}
              fill="none"
              stroke={color}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )
      })}
    </svg>
  )
}
