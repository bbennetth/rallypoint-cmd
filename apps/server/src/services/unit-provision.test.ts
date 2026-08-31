import { describe, expect, it } from 'vitest'
import { GAMES, type GameDef } from '@rallypoint-cmd/shared'
import { renderInstanceDropIn, renderStartScript } from './unit-provision.js'
import { ALLOWED_SLUGS, ALLOWED_UNITS } from './constants.js'

// The start script and drop-in used to live in a bash helper with its own
// copy of the game table. They are now rendered from the registry, so
// these tests stand in for the old sudoers/helper drift checks: whatever
// games.ts says is what lands in the unit.

const palworld = GAMES['palworld'] as GameDef
const enshrouded = GAMES['enshrouded'] as GameDef

describe('renderStartScript', () => {
  it('cds into the install dir and execs the registry command (native Linux)', () => {
    const script = renderStartScript(palworld, '/opt/games/palworld')
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain('cd "/opt/games/palworld"')
    expect(script).toContain('export HOME="/opt/games/palworld"')
    expect(script).toContain(
      'exec ./PalServer.sh -useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS',
    )
    // Native servers get the game's own lib dirs on the search path.
    expect(script).toContain('LD_LIBRARY_PATH="/opt/games/palworld:/opt/games/palworld/linux64:')
    expect(script).not.toContain('WINEPREFIX')
    expect(script).not.toContain('WINEESYNC')
  })

  it('wraps a Windows-only server in Wine with a run-time loader lookup', () => {
    const script = renderStartScript(enshrouded, '/opt/games/enshrouded')
    expect(script).toContain('export WINEPREFIX="/opt/games/enshrouded/.wine"')
    // Debian releases disagree on whether the 64-bit loader is `wine64`
    // or just `wine`, and Wine >= 9 dropped wine64 — so never hardcode it.
    expect(script).toContain('for c in wine64 wine; do')
    expect(script).not.toContain('/usr/bin/wine64')
    expect(script).toContain('exec "$WINE_BIN" ./enshrouded_server.exe')
    // esync/fsync: without them every Wine sync primitive round-trips
    // through the single-threaded wineserver.
    expect(script).toContain('export WINEESYNC=1')
    expect(script).toContain('export WINEFSYNC=1')
  })

  it('renders every registry game without an unresolved placeholder', () => {
    for (const game of Object.values(GAMES)) {
      const script = renderStartScript(game, `/opt/games/${game.slug}`)
      expect(script, game.slug).toContain(`cd "/opt/games/${game.slug}"`)
      expect(script, game.slug).toContain(game.startCommand.bin)
      expect(script, game.slug).not.toContain('undefined')
    }
  })
})

describe('renderInstanceDropIn', () => {
  it('carries the registry stop signal, timeout and memory caps', () => {
    const conf = renderInstanceDropIn(palworld, '/opt/games/palworld')
    expect(conf).toContain('[Service]')
    expect(conf).toContain('WorkingDirectory=/opt/games/palworld')
    expect(conf).toContain(`KillSignal=${palworld.stopSignal}`)
    expect(conf).toContain(`TimeoutStopSec=${palworld.timeoutStopSec}`)
    expect(conf).toContain(`MemoryHigh=${palworld.memoryHigh}`)
    expect(conf).toContain(`MemoryMax=${palworld.memoryMax}`)
  })

  it('omits memory caps a game does not declare', () => {
    const rust = GAMES['rust'] as GameDef
    expect(rust.memoryHigh).toBeUndefined()
    const conf = renderInstanceDropIn(rust, '/opt/games/rust')
    expect(conf).not.toContain('MemoryHigh=')
    expect(conf).not.toContain('MemoryMax=')
  })

  it('lets per-server overrides win over the registry caps and adds a CPU quota', () => {
    const conf = renderInstanceDropIn(palworld, '/opt/games/palworld', {
      memoryHigh: '30G',
      memoryMax: null,
      cpuQuotaPct: 400,
    })
    expect(conf).toContain('MemoryHigh=30G')
    // null override = fall through to the registry default.
    expect(conf).toContain(`MemoryMax=${palworld.memoryMax}`)
    expect(conf).toContain('CPUQuota=400%')
  })

  it('omits CPUQuota when no override sets one', () => {
    expect(renderInstanceDropIn(palworld, '/opt/games/palworld')).not.toContain('CPUQuota=')
  })

  it('refuses malformed override values before they reach a systemd file', () => {
    expect(() =>
      renderInstanceDropIn(palworld, '/opt/games/palworld', {
        memoryHigh: '1G\nExecStart=/bin/sh',
        memoryMax: null,
        cpuQuotaPct: null,
      }),
    ).toThrow(/invalid memory limit/)
    expect(() =>
      renderInstanceDropIn(palworld, '/opt/games/palworld', {
        memoryHigh: null,
        memoryMax: 'infinity',
        cpuQuotaPct: null,
      }),
    ).toThrow(/invalid memory limit/)
    expect(() =>
      renderInstanceDropIn(palworld, '/opt/games/palworld', {
        memoryHigh: null,
        memoryMax: null,
        cpuQuotaPct: 1.5,
      }),
    ).toThrow(/invalid CPU quota/)
  })

  it('opens the install dir for writing under the template unit ProtectSystem=strict', () => {
    for (const game of Object.values(GAMES)) {
      expect(renderInstanceDropIn(game, `/opt/games/${game.slug}`), game.slug).toContain(
        `ReadWritePaths=/opt/games/${game.slug}`,
      )
    }
  })
})

describe('closed sets derived from the registry', () => {
  it('allows exactly the registry slugs and their template units', () => {
    expect([...ALLOWED_SLUGS].sort()).toEqual(Object.keys(GAMES).sort())
    expect(ALLOWED_UNITS).toHaveLength(Object.keys(GAMES).length)
    for (const unit of ALLOWED_UNITS) expect(unit).toMatch(/^rallypoint-game@[a-z0-9-]+\.service$/)
  })
})
