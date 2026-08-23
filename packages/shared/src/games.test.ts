import { describe, expect, it } from 'vitest'
import { GAMES, PALWORLD_APP_ID, appManifestFor, templateUnitFor } from './index.js'

// Registry invariants: the generated systemd units and the
// per-instance services all trust these properties.

describe('game registry', () => {
  const entries = Object.values(GAMES)

  it('keys match slugs and slugs are unit-instance safe', () => {
    for (const [key, game] of Object.entries(GAMES)) {
      expect(game.slug).toBe(key)
      // Slugs become systemd template instance names.
      expect(game.slug).toMatch(/^[a-z0-9-]{1,32}$/)
    }
  })

  it('app ids and slugs are unique', () => {
    expect(new Set(entries.map((g) => g.steamAppId)).size).toBe(entries.length)
    expect(new Set(entries.map((g) => g.slug)).size).toBe(entries.length)
  })

  it('ships the registry with Palworld as the full-support anchor', () => {
    expect(entries).toHaveLength(11)
    expect(GAMES['palworld']!.steamAppId).toBe(PALWORLD_APP_ID)
    expect(GAMES['palworld']!.supportLevel).toBe('full')
    expect(GAMES['enshrouded']!.supportLevel).toBe('full')
  })

  it('capability gates are consistent', () => {
    // Every world-capable game needs a matching contract in
    // apps/server backup-contracts.ts; every settings adapter belongs to
    // exactly one game today.
    const ADAPTER_OWNER: Record<string, string> = {
      'palworld-ini': 'palworld',
      'enshrouded-json': 'enshrouded',
    }
    for (const game of entries) {
      if (game.capabilities.world) expect(['palworld', 'enshrouded']).toContain(game.slug)
      if (game.capabilities.players) expect(game.capabilities.query).not.toBe('none')
      if (game.settingsAdapter !== 'none') expect(game.slug).toBe(ADAPTER_OWNER[game.settingsAdapter])
      // Windows-only servers run under Wine and exec a .exe.
      if (game.platform === 'windows') expect(game.startCommand.bin.endsWith('.exe')).toBe(true)
      expect(game.installedProbe.startsWith('/')).toBe(false)
      expect(game.savePaths.length).toBeGreaterThan(0)
      expect(game.diskEstimateGb).toBeGreaterThan(0)
    }
    // Wine is scoped: only Enshrouded is a Windows-platform game today.
    expect(entries.filter((g) => g.platform === 'windows').map((g) => g.slug)).toEqual(['enshrouded'])
  })

  it('derives manifest + unit names', () => {
    expect(appManifestFor(2394010)).toBe('steamapps/appmanifest_2394010.acf')
    expect(templateUnitFor('valheim')).toBe('rallypoint-game@valheim.service')
  })
})
