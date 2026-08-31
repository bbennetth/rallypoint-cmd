export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts = []
  if (d) parts.push(`${d}d`)
  if (h || d) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

export function formatSince(ms: number | null | undefined): string {
  if (ms == null) return '—'
  return formatUptime(Math.floor((Date.now() - ms) / 1000))
}

// Relative "x ago" label; sub-minute (and clock-skewed future) times
// read as "just now" rather than "0m ago" / "—".
export function formatAgo(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const seconds = Math.floor((Date.now() - ms) / 1000)
  if (seconds < 60) return 'just now'
  return `${formatUptime(seconds)} ago`
}

export function formatDateTime(ms: number | null | undefined): string {
  if (ms == null) return '—'
  return new Date(ms).toLocaleString()
}
