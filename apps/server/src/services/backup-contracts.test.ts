import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GAMES } from '@rallypoint-cmd/shared'
import { contractFor, contractForSlug, type WorldContract } from './backup-contracts.js'

// The contract is what the backup engine trusts about a game's on-disk
// shape. These tests build a synthetic save tree per game and check the
// three claims the engine leans on: the live save is found, an archive's
// own entries are accepted while foreign ones are not, and a restored
// tree is recognized as a real save.

const tmpDirs: string[] = []

function tmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function write(root: string, rel: string, body = 'x'): void {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}

// Enough of a save tree that each game's looksLikeSave() probe passes.
// Keyed by slug so the table doubles as documentation of what the panel
// considers "a real save" per game.
const SAVE_FIXTURES: Record<string, string[]> = {
  palworld: ['Pal/Saved/SaveGames/0/0123456789ABCDEF0123456789ABCDEF/Level.sav'],
  enshrouded: ['savegame/3ce9f1e3.db'],
  valheim: ['.config/unity3d/IronGate/Valheim/worlds_local/Dedicated.db', '.config/unity3d/IronGate/Valheim/worlds_local/Dedicated.fwl'],
  rust: ['server/rallypoint/proceduralmap.4250.5000.221.sav', 'server/rallypoint/cfg/server.cfg'],
  'ark-survival-evolved': ['ShooterGame/Saved/SavedArks/TheIsland.ark'],
  '7-days-to-die': ['.local/share/7DaysToDie/Saves/Navezgane/Rallypoint/main.ttp'],
  'project-zomboid': ['Zomboid/Saves/Multiplayer/servertest/map_p.bin', 'Zomboid/Logs/server.txt'],
  satisfactory: ['.config/Epic/FactoryGame/Saved/SaveGames/server/rallypoint.sav'],
  unturned: ['Servers/rallypoint/Level/Rallypoint/Level.dat'],
}

// An extracted archive is not laid out like an install dir for every
// game: Palworld archives the save under `SaveGames/0/<worldId>` while
// the install nests it under `Pal/Saved/`. Games whose archive root is
// the install-relative save root reuse SAVE_FIXTURES.
const ARCHIVE_FIXTURES: Record<string, string[]> = {
  palworld: ['SaveGames/0/0123456789ABCDEF0123456789ABCDEF/Level.sav'],
}

// Every game that has a contract, whether or not its registry entry has
// flipped `capabilities.world` on yet.
const SLUGS = Object.keys(SAVE_FIXTURES)

function seedFrom(files: string[]): string {
  const root = tmpdir()
  for (const rel of files) write(root, rel)
  return root
}

// A fake install dir holding a live save.
function seed(slug: string): string {
  return seedFrom(SAVE_FIXTURES[slug]!)
}

// A fake extracted-archive dir holding a staged save.
function seedArchive(slug: string): string {
  return seedFrom(ARCHIVE_FIXTURES[slug] ?? SAVE_FIXTURES[slug]!)
}

// The archive layout the engine builds for a contract: the save root
// plus each ancestor dir, as tar emits them.
function archiveEntriesFor(contract: WorldContract, worldId: string | null): string[] {
  const root = contract.archiveSaveRoot(worldId)
  const segments = root.split('/')
  const dirs = segments.map((_, i) => segments.slice(0, i + 1).join('/'))
  return [...dirs, `${root}/some-file.sav`]
}

describe.each(SLUGS)('%s world contract', (slug) => {
  const contract = contractForSlug(slug)!

  it('is registered', () => {
    expect(contract).toBeDefined()
    expect(contract.gameSlug).toBe(slug)
  })

  it('resolves a live save dir from a seeded install', () => {
    const live = contract.resolveLive(seed(slug))
    expect(live).not.toBeNull()
    expect(fs.existsSync(live!.saveDir)).toBe(true)
  })

  it('reports no live save on an empty install dir', () => {
    expect(contract.resolveLive(tmpdir())).toBeNull()
  })

  it('accepts its own archive entries', () => {
    const live = contract.resolveLive(seed(slug))!
    for (const entry of archiveEntriesFor(contract, live.worldId)) {
      expect(contract.classifyEntry(entry).kind, entry).not.toBe('unknown')
    }
    expect(contract.classifyEntry('manifest.json').kind).toBe('manifest')
    for (const cfg of contract.configFiles) {
      expect(contract.classifyEntry(path.basename(cfg)).kind).toBe('settings')
    }
  })

  it('rejects foreign and traversal entries', () => {
    for (const entry of ['../../etc/passwd', 'etc/passwd', 'unrelated/file.sav', '/absolute/path.sav']) {
      expect(contract.classifyEntry(entry).kind, entry).toBe('unknown')
    }
  })

  it('verifies a well-shaped extracted archive and rejects an empty one', () => {
    expect(() => contract.verifyExtracted(seedArchive(slug))).not.toThrow()
    expect(() => contract.verifyExtracted(tmpdir())).toThrow()
  })

  it('stages the save the archive actually carries', () => {
    const extractDir = seedArchive(slug)
    const staged = contract.stagedSaveTarget(extractDir)
    expect(fs.existsSync(staged.stagedDir), staged.stagedDir).toBe(true)
    expect(path.relative(extractDir, staged.stagedDir).startsWith('..')).toBe(false)
    // The staged world id is what the live target is resolved against.
    const liveDir = contract.liveSaveDirIn(seed(slug), staged.worldId)
    expect(path.isAbsolute(liveDir)).toBe(true)
  })

  it('fails validation when an archive carries no save files', () => {
    expect(() => contract.validateSaveShape(new Set(), 0)).toThrow()
  })
})

describe('contract registry', () => {
  it('covers every game whose registry entry enables world backups', () => {
    for (const game of Object.values(GAMES)) {
      if (game.capabilities.world) expect(() => contractFor(game)).not.toThrow()
    }
  })

  it('throws for a game with backups enabled but no contract', () => {
    const bogus = { ...GAMES['palworld']!, slug: 'no-such-game', name: 'No Such Game' }
    expect(() => contractFor(bogus)).toThrow(/no world contract/)
  })

  it('archives Project Zomboid’s Server dir, because restore deletes whatever it omits', () => {
    // Restore swaps the whole save root, so anything excluded here is
    // deleted from the live tree — and Server/ holds the sandbox ruleset
    // (`<name>_SandboxVars.lua`). Only logs are safe to drop.
    const contract = contractForSlug('project-zomboid')!
    expect([...contract.internalBackupDirs]).toEqual(['Logs'])
    // The ini still rides along separately so the panel's managed keys
    // are re-applied through the settings adapter on restore.
    expect(contract.settingsImportFile).toBe('rallypoint.ini')
  })

  it('excludes nothing that a restore would then delete from the live tree', () => {
    // A dir excluded from the archive is a dir the swap removes. Only
    // regenerable content may appear here.
    const REGENERABLE = new Set(['Logs', 'backup', 'crashes'])
    for (const slug of SLUGS) {
      for (const dir of contractForSlug(slug)!.internalBackupDirs) {
        expect(REGENERABLE.has(dir), `${slug} excludes ${dir} from its archive`).toBe(true)
      }
    }
  })
})
