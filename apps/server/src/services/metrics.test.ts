import { describe, expect, it } from 'vitest'
import { GAMES, DEFAULT_ERROR_PATTERNS, compileErrorMatcher, parseSystemdBytes } from '@rallypoint-cmd/shared'
import { cpuPercent, parseKeyedStat, parsePsiAvg10 } from './metrics.real.js'

// The sampler's arithmetic and parsing, which is where a monitoring
// panel earns or loses its trust: a chart that silently reads zero is
// worse than no chart, because it says "everything is fine".

describe('parseKeyedStat', () => {
  it('reads a cgroup v2 cpu.stat', () => {
    const stat = parseKeyedStat(
      ['usage_usec 91234567', 'user_usec 70000000', 'system_usec 21234567', 'nr_periods 812', 'nr_throttled 44', 'throttled_usec 1250000', ''].join('\n'),
    )
    expect(stat.get('usage_usec')).toBe(91_234_567)
    expect(stat.get('throttled_usec')).toBe(1_250_000)
    expect(stat.get('nr_throttled')).toBe(44)
  })

  it('omits keys with non-numeric values rather than storing NaN', () => {
    const stat = parseKeyedStat('usage_usec max\nuser_usec 5\n')
    expect(stat.has('usage_usec')).toBe(false)
    expect(stat.get('user_usec')).toBe(5)
  })

  it('tolerates an empty file', () => {
    expect(parseKeyedStat('').size).toBe(0)
  })
})

describe('parsePsiAvg10', () => {
  it('reads the `some` line', () => {
    const psi = 'some avg10=12.34 avg60=4.56 avg300=1.20 total=987654\nfull avg10=2.00 avg60=1.00 avg300=0.50 total=123\n'
    expect(parsePsiAvg10(psi)).toBeCloseTo(12.34)
  })

  it('ignores the `full` line even when it comes first', () => {
    expect(parsePsiAvg10('full avg10=99.00 avg60=1 avg300=1 total=1\nsome avg10=3.50 avg60=1 avg300=1 total=1\n')).toBeCloseTo(3.5)
  })

  it('returns null for an unparseable or empty file', () => {
    // PSI compiled out of the kernel: a missing metric, not a zero one.
    expect(parsePsiAvg10('')).toBeNull()
    expect(parsePsiAvg10('nonsense')).toBeNull()
  })
})

describe('cpuPercent', () => {
  const cores = 4

  it('is null on the first sample (no baseline to delta against)', () => {
    expect(cpuPercent(null, { usageUsec: 1_000_000, atMs: 1_000 }, cores)).toBeNull()
  })

  it('reports one fully-busy core as 1/cores of the host', () => {
    // 1s of CPU over 1s of wall clock on a 4-core host = 25%.
    const prev = { usageUsec: 0, atMs: 0 }
    const curr = { usageUsec: 1_000_000, atMs: 1_000 }
    expect(cpuPercent(prev, curr, cores)).toBeCloseTo(25)
  })

  it('reports every core busy as 100%', () => {
    expect(cpuPercent({ usageUsec: 0, atMs: 0 }, { usageUsec: 4_000_000, atMs: 1_000 }, cores)).toBeCloseTo(100)
  })

  it('clamps above 100% rather than reporting an impossible figure', () => {
    // Can happen when the wall-clock delta is short and accounting lags.
    expect(cpuPercent({ usageUsec: 0, atMs: 0 }, { usageUsec: 9_000_000, atMs: 1_000 }, cores)).toBe(100)
  })

  it('is null when the counter went backwards (cgroup recreated by a restart)', () => {
    // The critical case: a restart resets usage_usec, and treating that
    // as a delta would draw a 0% sample right where the interesting
    // event was.
    expect(cpuPercent({ usageUsec: 5_000_000, atMs: 0 }, { usageUsec: 10_000, atMs: 5_000 }, cores)).toBeNull()
  })

  it('is null when no wall time passed', () => {
    expect(cpuPercent({ usageUsec: 0, atMs: 1_000 }, { usageUsec: 500, atMs: 1_000 }, cores)).toBeNull()
  })
})

describe('parseSystemdBytes', () => {
  it('parses the suffixes systemd emits, as powers of two', () => {
    expect(parseSystemdBytes('12G')).toBe(12 * 1024 ** 3)
    expect(parseSystemdBytes('512M')).toBe(512 * 1024 ** 2)
    expect(parseSystemdBytes('1.5G')).toBe(Math.round(1.5 * 1024 ** 3))
    expect(parseSystemdBytes('2048')).toBe(2048)
  })

  it('returns null for absent or unbounded limits', () => {
    expect(parseSystemdBytes(undefined)).toBeNull()
    expect(parseSystemdBytes('')).toBeNull()
    expect(parseSystemdBytes('infinity')).toBeNull()
    expect(parseSystemdBytes('12 gigabytes')).toBeNull()
  })

  it('reads the registry limits the Monitoring page draws against', () => {
    expect(parseSystemdBytes(GAMES.enshrouded!.memoryHigh)).toBe(12 * 1024 ** 3)
    expect(parseSystemdBytes(GAMES.enshrouded!.memoryMax)).toBe(16 * 1024 ** 3)
  })
})

describe('compileErrorMatcher', () => {
  it("matches Enshrouded's overload line — the reason this page exists", () => {
    const m = compileErrorMatcher(GAMES.enshrouded!.logPatterns!.error)
    expect(m).not.toBeNull()
    expect(m!.test('[Enshrouded] Server overloaded — simulation tick took 812ms')).toBe(true)
    expect(m!.test('the server is overloading, reduce the player count')).toBe(true)
  })

  it('leaves ordinary console chatter alone', () => {
    const m = compileErrorMatcher(GAMES.enshrouded!.logPatterns!.error)!
    expect(m.test('[Enshrouded] tick players=2 fps=59.8')).toBe(false)
    expect(m.test('[systemd] Starting rallypoint-game@enshrouded.service...')).toBe(false)
  })

  it('matches the generic set for games with no patterns of their own', () => {
    const m = compileErrorMatcher(DEFAULT_ERROR_PATTERNS)!
    expect(m.test('ERROR: could not bind port')).toBe(true)
    expect(m.test('Warning: save took 4s')).toBe(true)
    expect(m.test('Fatal exception in worker')).toBe(true)
    expect(m.test('World loaded successfully')).toBe(false)
  })

  it('drops invalid patterns instead of throwing, so one bad regex cannot stop sampling', () => {
    const m = compileErrorMatcher(['oops(', 'overload'])
    expect(m).not.toBeNull()
    expect(m!.test('server overload detected')).toBe(true)
  })

  it('returns null when nothing compiles', () => {
    expect(compileErrorMatcher(['oops('])).toBeNull()
    expect(compileErrorMatcher([])).toBeNull()
  })
})
