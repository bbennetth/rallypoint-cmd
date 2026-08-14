import { describe, expect, it } from 'vitest'
import { GAMES, PALWORLD_APP_ID, appManifestFor, templateUnitFor } from './index.js'

// Registry invariants: the deploy files (sudoers, systemd) and the
// per-instance services all trust these properties.

describe('game registry', () => {
  const entries = Object.values(GAMES)

  it('keys match slugs and slugs are unit-instance safe', () => {
    for (const [key, game] of Object.entries(GAMES)) {
      expect(game.slug).toBe(key)
      // Same charset the rallypoint-cmd-game root helper validates.
      expect(game.slug).toMatch(/^[a-z0-9-]{1,32}$/)
    }
  })

  it('app ids and slugs are unique', () => {
    expect(new Set(entries.map((g) => g.steamAppId)).size).toBe(entries.length)
    expect(new Set(entries.map((g) => g.slug)).size).toBe(entries.length)
  })

  it('ships the top-10 list with Palworld as the full-support anchor', () => {
    expect(entries).toHaveLength(10)
    expect(GAMES['palworld']!.steamAppId).toBe(PALWORLD_APP_ID)
    expect(GAMES['palworld']!.supportLevel).toBe('full')
  })

  it('capability gates are consistent', () => {
    for (const game of entries) {
      // The backup engine's archive contract assumes Palworld world-id
      // semantics; only pal-rest games may claim players today.
      if (game.capabilities.world) expect(game.slug).toBe('palworld')
      if (game.capabilities.players) expect(game.capabilities.query).not.toBe('none')
      if (game.settingsAdapter === 'palworld-ini') expect(game.slug).toBe('palworld')
      expect(game.installedProbe.startsWith('/')).toBe(false)
      expect(game.savePaths.length).toBeGreaterThan(0)
      expect(game.diskEstimateGb).toBeGreaterThan(0)
    }
  })

  it('derives manifest + unit names', () => {
    expect(appManifestFor(2394010)).toBe('steamapps/appmanifest_2394010.acf')
    expect(templateUnitFor('valheim')).toBe('rallypoint-game@valheim.service')
  })
})
