import { describe, expect, it } from 'vitest'
import { codenameSupported, createFakeWineUpdate, parseWineVersion, readCodename } from './wine-update.js'

describe('parseWineVersion', () => {
  it('detects a WineHQ staging build', () => {
    expect(parseWineVersion('wine-10.4 (Staging)\n')).toEqual({
      version: 'wine-10.4 (Staging)',
      staging: true,
    })
  })

  it('detects a vanilla Debian build', () => {
    expect(parseWineVersion('wine-8.0\n')).toEqual({ version: 'wine-8.0', staging: false })
  })

  it('skips leading noise and picks the wine- line', () => {
    expect(parseWineVersion('it looks like wine crashed\nwine-9.0 (Staging)')).toEqual({
      version: 'wine-9.0 (Staging)',
      staging: true,
    })
  })

  it('returns null for garbage or empty output rather than a wrong version', () => {
    expect(parseWineVersion('command not found')).toEqual({ version: null, staging: false })
    expect(parseWineVersion('')).toEqual({ version: null, staging: false })
  })
})

describe('codenameSupported', () => {
  it('accepts bookworm and trixie, quoted or bare', () => {
    expect(codenameSupported('ID=debian\nVERSION_CODENAME=bookworm\n')).toBe(true)
    expect(codenameSupported('VERSION_CODENAME="trixie"\n')).toBe(true)
  })

  it('rejects other codenames', () => {
    expect(codenameSupported('VERSION_CODENAME=bullseye\n')).toBe(false)
    expect(codenameSupported('VERSION_CODENAME=noble\n')).toBe(false)
  })

  it('rejects a missing line or a missing file (read as empty)', () => {
    expect(codenameSupported('ID=debian\nPRETTY_NAME="Debian"\n')).toBe(false)
    expect(codenameSupported('')).toBe(false)
  })

  it('readCodename returns the unquoted value or null', () => {
    expect(readCodename('VERSION_CODENAME="bookworm"')).toBe('bookworm')
    expect(readCodename('VERSION_CODENAME=')).toBeNull()
    expect(readCodename('ID=debian')).toBeNull()
  })
})

describe('fake wine updater lifecycle', () => {
  it('starts on vanilla wine and reports staging after the op runs', async () => {
    const lines: string[] = []
    const sink = { line: (t: string) => lines.push(t), progress: () => {} }
    const svc = createFakeWineUpdate()

    let s = await svc.status()
    expect(s).toEqual({
      installed: true,
      version: 'wine-8.0',
      staging: false,
      upgradeSupported: true,
    })

    await svc.run(sink)
    expect(lines.join('\n')).toContain('winehq-staging')

    s = await svc.status()
    expect(s.staging).toBe(true)
    expect(s.installed).toBe(true)
    expect(s.version).toMatch(/^wine-10\./)
  })
})
