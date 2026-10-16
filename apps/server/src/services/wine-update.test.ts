import { describe, expect, it } from 'vitest'
import {
  branchPackages,
  codenameSupported,
  createFakeWineUpdate,
  parseInstalledBranch,
  parseMadison,
  parseWineVersion,
  readCodename,
  wineVersionLabel,
} from './wine-update.js'

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

describe('parseMadison', () => {
  const out = [
    'winehq-stable | 10.0.0.0~bookworm-1 | https://dl.winehq.org/wine-builds/debian bookworm/main amd64 Packages',
    'winehq-stable | 9.0.0.0~bookworm-1 | https://dl.winehq.org/wine-builds/debian bookworm/main amd64 Packages',
    'winehq-staging | 11.16~bookworm-1 | https://dl.winehq.org/wine-builds/debian bookworm/main amd64 Packages',
    'winehq-staging | 11.16~bookworm-1 | https://dl.winehq.org/wine-builds/debian bookworm/main i386 Packages',
    'winehq-staging | 11.15~bookworm-1 | https://dl.winehq.org/wine-builds/debian bookworm/main amd64 Packages',
    'N: Unable to locate package winehq-devel',
    'wine | 8.0~repack-4 | http://deb.debian.org/debian bookworm/main amd64 Packages',
  ].join('\n')

  it('groups versions per branch, newest first, without duplicates', () => {
    const b = parseMadison(out)
    expect(b.stable.map((o) => o.label)).toEqual(['10.0.0.0', '9.0.0.0'])
    expect(b.staging).toEqual([
      { aptVersion: '11.16~bookworm-1', label: '11.16' },
      { aptVersion: '11.15~bookworm-1', label: '11.15' },
    ])
    expect(b.devel).toEqual([])
  })

  it('ignores non-WineHQ packages and malformed versions', () => {
    expect(parseMadison('winehq-staging | --force-yes | x\nfoo | 1.0 | y')).toEqual({
      stable: [],
      devel: [],
      staging: [],
    })
  })
})

describe('parseInstalledBranch', () => {
  it('returns the fully installed winehq branch', () => {
    const out = 'winehq-stable\t\tun \nwinehq-staging\t11.16~bookworm-1\tii \n'
    expect(parseInstalledBranch(out)).toEqual({ branch: 'staging', aptVersion: '11.16~bookworm-1' })
  })

  it('skips removed-but-configured packages and returns null for Debian wine', () => {
    expect(parseInstalledBranch('winehq-staging\t11.15~bookworm-1\trc \n')).toBeNull()
    expect(parseInstalledBranch('')).toBeNull()
  })
})

describe('branchPackages / wineVersionLabel', () => {
  it('pins every half of a branch, the i386 one only with multiarch', () => {
    expect(branchPackages('stable', true)).toEqual([
      'winehq-stable',
      'wine-stable',
      'wine-stable-amd64',
      'wine-stable-i386',
    ])
    expect(branchPackages('devel', false)).toEqual(['winehq-devel', 'wine-devel', 'wine-devel-amd64'])
  })

  it('drops the distro suffix for display', () => {
    expect(wineVersionLabel('11.16~trixie-1')).toBe('11.16')
    expect(wineVersionLabel('10.0.0.0~bookworm-1')).toBe('10.0.0.0')
  })
})

describe('fake wine manager lifecycle', () => {
  const sink = () => {
    const lines: string[] = []
    return { lines, line: (t: string) => lines.push(t), progress: () => {} }
  }

  it('starts on Debian wine, installs the newest build unpinned', async () => {
    const svc = createFakeWineUpdate()
    let s = await svc.status()
    expect(s).toMatchObject({ installed: true, version: 'wine-8.0', branch: null, held: false })

    await svc.run(sink(), { branch: 'staging', version: null })
    s = await svc.status()
    expect(s).toMatchObject({ branch: 'staging', aptVersion: '11.16~bookworm-1', held: false, staging: true })
  })

  it('installs and pins a specific version, and refuses one the repo lacks', async () => {
    const svc = createFakeWineUpdate()
    await svc.run(sink(), { branch: 'stable', version: '9.0.0.0~bookworm-1' })
    expect(await svc.status()).toMatchObject({ branch: 'stable', aptVersion: '9.0.0.0~bookworm-1', held: true })

    await expect(svc.run(sink(), { branch: 'stable', version: '1.0~bookworm-1' })).rejects.toThrow(/not offered/)
  })

  it('lists versions per branch', async () => {
    const v = await createFakeWineUpdate().versions({ refresh: true })
    expect(v.repoConfigured).toBe(true)
    expect(v.branches.staging[0]!.label).toBe('11.16')
  })
})
