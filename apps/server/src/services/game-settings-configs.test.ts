import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GAMES } from '@rallypoint-cmd/shared'
import { readAdminCreds } from './admin-creds.js'
import { launchConfConfigFor, settingsConfigForSlug } from './game-settings-configs.js'
import { launchConfFormat, type SettingsDoc } from './settings-formats.js'

// The invariants are the panel's grip on each game: they are what makes
// the admin channel exist at all, so they are checked per game against a
// realistic config — including the case that matters most, an operator
// (or a restored backup) having turned them off.

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

// Run a slug's invariants over a starting file and hand back the result.
function applied(slug: string, content: string): SettingsDoc {
  const config = settingsConfigForSlug(slug)!
  const doc = config.format.parse(content)
  config.applyInvariants(doc)
  return doc
}

function seeded(slug: string): SettingsDoc {
  const config = settingsConfigForSlug(slug)!
  return applied(slug, config.seedContent?.() ?? '')
}

// A launch conf as the panel writes it: pairs are comments, since the
// file is dot-sourced (see settings-formats.ts).
function launchConf(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([k, v]) => `#: ${k} ${v}`)
    .join('\n')
}

describe('every generic-engine game has a settings config', () => {
  const SLUGS = [
    'valheim',
    'rust',
    'ark-survival-evolved',
    '7-days-to-die',
    'project-zomboid',
    'team-fortress-2',
    'counter-strike-2',
    'unturned',
  ]

  it.each(SLUGS)('%s resolves a config whose file path is install-relative', (slug) => {
    const config = settingsConfigForSlug(slug)!
    expect(config).toBeTruthy()
    expect(config.slug).toBe(slug)
    expect(path.isAbsolute(config.file)).toBe(false)
  })

  it.each(SLUGS)('%s seeds a file its own parser accepts', (slug) => {
    const config = settingsConfigForSlug(slug)!
    const seed = config.seedContent?.()
    if (seed === null || seed === undefined) return
    expect(() => config.format.serialize(applied(slug, seed))).not.toThrow()
  })

  it.each(SLUGS)('%s writes a seed that survives being read back', (slug) => {
    // A seed written in a shape its own format cannot parse is dropped
    // silently, leaving a freshly installed server unconfigured — which
    // is exactly what a launch conf written as bare pairs used to do.
    const config = settingsConfigForSlug(slug)!
    const seed = config.seedContent?.()
    if (!seed) return
    const written = config.format.serialize(applied(slug, seed))
    const reread = config.format.parse(written)
    for (const [key, value] of config.format.parse(seed).entries) {
      expect(reread.entries.get(key), `${slug}/${key}`).toBe(value)
    }
    // And the seed's declared settings are actually in the file.
    const declared = seed.split('\n').filter((l) => l.trim() !== '').length
    if (declared > 0 && config.format === launchConfFormat) {
      expect(reread.entries.size, `${slug} launch conf lost its seed`).toBeGreaterThanOrEqual(declared)
    }
  })

  it.each(SLUGS)('%s leaves no managed key unset after a seed', (slug) => {
    const config = settingsConfigForSlug(slug)!
    if (!config.seedContent) return
    const doc = seeded(slug)
    for (const key of config.managedKeys) {
      expect(doc.entries.get(key), `${slug}/${key}`).toBeTruthy()
    }
  })
})

describe('ARK invariants', () => {
  it('turns RCON back on and pins the registry port', () => {
    const doc = applied(
      'ark-survival-evolved',
      ['[ServerSettings]', 'RCONEnabled=False', 'RCONPort=1234', 'ServerAdminPassword=keepme'].join('\n'),
    )
    expect(doc.entries.get('ServerSettings/RCONEnabled')).toBe('True')
    expect(doc.entries.get('ServerSettings/RCONPort')).toBe(
      String(GAMES['ark-survival-evolved']!.ports.find((p) => p.name === 'rcon')?.port ?? 27020),
    )
  })

  it('keeps an existing admin password rather than rotating it', () => {
    const doc = applied('ark-survival-evolved', '[ServerSettings]\nServerAdminPassword=keepme')
    expect(doc.entries.get('ServerSettings/ServerAdminPassword')).toBe('keepme')
  })

  it('generates an admin password when the file has none', () => {
    const password = seeded('ark-survival-evolved').entries.get('ServerSettings/ServerAdminPassword')
    expect(password).toMatch(/^[A-Za-z0-9_-]{20,}$/)
  })
})

describe('7 Days to Die invariants', () => {
  it('re-enables telnet on a shipped config that has it off', () => {
    const doc = applied(
      '7-days-to-die',
      [
        '<ServerSettings>',
        '  <property name="TelnetEnabled" value="false"/>',
        '  <property name="TelnetPassword" value=""/>',
        '</ServerSettings>',
      ].join('\n'),
    )
    expect(doc.entries.get('TelnetEnabled')).toBe('true')
    expect(doc.entries.get('TelnetPassword')).toBeTruthy()
  })
})

describe('Valheim launch conf', () => {
  it('pins the game port the unit was provisioned with', () => {
    const doc = applied('valheim', launchConf({ '-name': 'Rallypoint', '-port': '9999' }))
    expect(doc.entries.get('-port')).toBe(String(GAMES['valheim']!.ports.find((p) => p.name === 'game')!.port))
  })

  it('rejects a password Valheim itself would refuse', () => {
    expect(() => applied('valheim', launchConf({ '-name': 'Rallypoint', '-password': 'abc' }))).toThrow(
      /at least 5 characters/,
    )
  })

  it('rejects a password equal to the world name', () => {
    expect(() => applied('valheim', launchConf({ '-world': 'Dedicated', '-password': 'Dedicated' }))).toThrow(
      /world name/,
    )
  })

  it('accepts an empty password and a valid one', () => {
    expect(() => applied('valheim', launchConf({ '-password': '' }))).not.toThrow()
    expect(() => applied('valheim', launchConf({ '-password': 'longenough' }))).not.toThrow()
  })
})

describe('Project Zomboid invariants', () => {
  it('pins the RCON port and fills in a password', () => {
    const doc = applied('project-zomboid', 'PublicName=Rallypoint\nRCONPort=1\nRCONPassword=')
    expect(doc.entries.get('RCONPort')).toBe(
      String(GAMES['project-zomboid']!.ports.find((p) => p.name === 'rcon')?.port ?? 27025),
    )
    expect(doc.entries.get('RCONPassword')).toBeTruthy()
  })
})

describe('Source cfg invariants', () => {
  it.each(['team-fortress-2', 'counter-strike-2'])('%s fills in an rcon_password', (slug) => {
    const doc = applied(slug, 'hostname "Rallypoint"')
    expect(doc.entries.get('rcon_password')).toMatch(/^[A-Za-z0-9_-]{20,}$/)
  })
})

describe('one home per credential', () => {
  it('never manages the same credential in two files for one game', () => {
    // Two files each generating their own secret for the SAME credential
    // means the server uses one and the panel reads the other, so the
    // admin channel fails with a password nobody can see is wrong. A game
    // may legitimately hold two DIFFERENT secrets (Project Zomboid has an
    // admin account and an RCON password), so compare by credential.
    const credential = (key: string): string =>
      key.replace(/^[+-]/, '').replace(/[._]/g, '').toLowerCase()
    for (const game of Object.values(GAMES)) {
      const primary = settingsConfigForSlug(game.slug)
      const launch = launchConfConfigFor(game)
      if (!primary || !launch) continue
      const inPrimary = new Set(primary.managedKeys.filter((k) => /password/i.test(k)).map(credential))
      for (const key of launch.managedKeys.filter((k) => /password/i.test(k))) {
        expect(inPrimary.has(credential(key)), `${game.slug} manages ${key} in two files`).toBe(false)
      }
    }
  })
})

describe('launch-only settings', () => {
  it('offers the Steam login token exactly once per game', () => {
    // Declared in the shared Source spec table but stored in the launch
    // conf, so the file-backed config must not also claim it.
    for (const slug of ['team-fortress-2', 'counter-strike-2']) {
      const game = GAMES[slug]!
      const primary = settingsConfigForSlug(slug)!
      const launch = launchConfConfigFor(game)!
      expect(Object.keys(primary.specs)).not.toContain('+sv_setsteamaccount')
      expect(Object.keys(launch.specs)).toContain('+sv_setsteamaccount')
    }
  })

  it('leaves the token editable rather than panel-managed', () => {
    // The operator supplies it; the panel has no way to generate one.
    for (const slug of ['team-fortress-2', 'counter-strike-2']) {
      const launch = launchConfConfigFor(GAMES[slug]!)!
      expect([...launch.managedKeys]).not.toContain('+sv_setsteamaccount')
    }
  })

  it('omits a token the operator has not set instead of passing a bare flag', () => {
    // `+sv_setsteamaccount` with no value would make the game read the
    // next argument as the token.
    const doc = launchConfFormat.parse('')
    launchConfFormat.set(doc, '+sv_setsteamaccount', '')
    launchConfFormat.set(doc, '+ip', '0.0.0.0')
    expect(launchConfFormat.serialize(doc)).toContain("set -- '+ip' '0.0.0.0'")
    expect(launchConfFormat.serialize(doc)).not.toContain('sv_setsteamaccount')
  })

  it('keeps Unturned’s token in Commands.dat, which the game reads directly', () => {
    const config = settingsConfigForSlug('unturned')!
    expect(Object.keys(config.specs)).toContain('gslt')
    expect(config.file).toContain('Commands.dat')
  })
})

describe('config write path feeds the admin clients', () => {
  it('a seeded ARK config is readable as RCON credentials', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-ark-'))
    tmpDirs.push(dir)
    const config = settingsConfigForSlug('ark-survival-evolved')!
    const file = path.join(dir, config.file)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, config.format.serialize(seeded('ark-survival-evolved')))

    const creds = readAdminCreds('ark-survival-evolved', dir)
    expect(creds.password).toBeTruthy()
    expect(creds.port).toBe(GAMES['ark-survival-evolved']!.ports.find((p) => p.name === 'rcon')?.port ?? 27020)
  })
})
