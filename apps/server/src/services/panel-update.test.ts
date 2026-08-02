import { describe, expect, it } from 'vitest'
import { formatHelperFailure, isNewerVersion } from './panel-update.js'

describe('formatHelperFailure', () => {
  it('includes the exit code and the stderr lines', () => {
    expect(formatHelperFailure(1, 'refusing: staging dir missing release.json\n')).toBe(
      'Apply helper failed (exit 1): refusing: staging dir missing release.json',
    )
  })

  it('keeps only the last 5 stderr lines', () => {
    const stderr = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n')
    const msg = formatHelperFailure(2, stderr)
    expect(msg).toBe('Apply helper failed (exit 2): three | four | five | six | seven')
  })

  it('skips blank lines and trims whitespace', () => {
    expect(formatHelperFailure(1, '\n  rsync: error 23  \n\n')).toBe(
      'Apply helper failed (exit 1): rsync: error 23',
    )
  })

  it('says so when the helper produced no output', () => {
    expect(formatHelperFailure(1, '')).toBe('Apply helper failed (exit 1) with no output.')
  })

  it('omits the exit code when unknown', () => {
    // sudo -n denial or a timeout kill can reject without a numeric code.
    expect(formatHelperFailure(undefined, 'sudo: a password is required')).toBe(
      'Apply helper failed: sudo: a password is required',
    )
  })

  it('accepts string codes (signal names)', () => {
    expect(formatHelperFailure('SIGTERM', '')).toBe('Apply helper failed (exit SIGTERM) with no output.')
  })
})

// Keep the existing exported helper covered from this file too, since it
// had no test file until now.
describe('isNewerVersion', () => {
  it('compares semver-ish tags', () => {
    expect(isNewerVersion('v0.1.6', 'v0.1.7')).toBe(true)
    expect(isNewerVersion('v0.1.7', 'v0.1.7')).toBe(false)
    expect(isNewerVersion('v0.2.0', 'v0.1.9')).toBe(false)
  })

  it('treats unparseable versions as updates when they differ', () => {
    expect(isNewerVersion('dev', 'v0.1.7')).toBe(true)
    expect(isNewerVersion('dev', 'dev')).toBe(false)
  })
})
