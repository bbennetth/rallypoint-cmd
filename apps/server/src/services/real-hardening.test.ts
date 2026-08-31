import { describe, expect, it } from 'vitest'
import { parseSystemdTimestamp } from './game-control.real.js'
import { decideSteamcmdOutcome, steamcmdArgs } from './steamcmd.real.js'
import { isNewerVersion } from './panel-update.js'
import {
  createFakePublicAccess,
  extractTunnelAddress,
  PlayitTrace,
  readGamePort,
} from './public-access.js'
import { parseA2sInfo } from './a2s.real.js'

describe('parseSystemdTimestamp', () => {
  it('parses the --timestamp=unix form (@epoch seconds → ms)', () => {
    expect(parseSystemdTimestamp('@1721445605')).toBe(1721445605_000)
  })

  it('parses the human UTC form via explicit ISO conversion', () => {
    expect(parseSystemdTimestamp('Sat 2026-07-20 03:20:05 UTC')).toBe(
      Date.parse('2026-07-20T03:20:05Z'),
    )
  })

  it('returns null for unset/empty/n/a', () => {
    expect(parseSystemdTimestamp('')).toBeNull()
    expect(parseSystemdTimestamp(undefined)).toBeNull()
    expect(parseSystemdTimestamp('0')).toBeNull()
    expect(parseSystemdTimestamp('n/a')).toBeNull()
  })

  it('returns null for garbage rather than a wrong number', () => {
    expect(parseSystemdTimestamp('not a date')).toBeNull()
  })
})

describe('decideSteamcmdOutcome', () => {
  it('trusts a Success! line even when the process exits non-zero (benign self-update)', () => {
    expect(decideSteamcmdOutcome({ code: 7, sawSuccess: true, sawError: false, lastErrorLine: null })).toEqual({
      ok: true,
    })
  })

  it('fails on an Error! line even when the process exits 0', () => {
    const out = decideSteamcmdOutcome({
      code: 0,
      sawSuccess: false,
      sawError: true,
      lastErrorLine: "Error! App '2394010' state is 0x606 after update job.",
    })
    expect(out).toEqual({ ok: false, message: "Error! App '2394010' state is 0x606 after update job." })
  })

  it('falls back to exit 0 = success when nothing definitive was printed', () => {
    expect(decideSteamcmdOutcome({ code: 0, sawSuccess: false, sawError: false, lastErrorLine: null })).toEqual({
      ok: true,
    })
  })

  it('fails on a non-zero exit with no success marker', () => {
    expect(
      decideSteamcmdOutcome({ code: 1, sawSuccess: false, sawError: false, lastErrorLine: null }),
    ).toMatchObject({ ok: false })
  })
})

describe('steamcmdArgs', () => {
  it('omits the platform override for native Linux targets', () => {
    const args = steamcmdArgs({ steamAppId: 2394010, installDir: '/opt/games/palworld' }, 'update')
    expect(args.join(' ')).not.toContain('sSteamCmdForcePlatformType')
    expect(args[0]).toBe('+force_install_dir')
  })

  it('forces the Windows depot AFTER +login (login resets earlier overrides) for platform: windows', () => {
    const args = steamcmdArgs(
      { steamAppId: 2278520, installDir: '/opt/games/enshrouded', platform: 'windows' },
      'install',
    )
    const platformIdx = args.indexOf('+@sSteamCmdForcePlatformType')
    expect(platformIdx).toBeGreaterThan(args.indexOf('+login'))
    expect(args[platformIdx + 1]).toBe('windows')
    expect(platformIdx).toBeLessThan(args.indexOf('+app_update'))
    expect(args).toContain('validate')
  })
})

describe('isNewerVersion (panel self-update)', () => {
  it('compares semver tags with or without the v prefix', () => {
    expect(isNewerVersion('v0.1.0', 'v0.2.0')).toBe(true)
    expect(isNewerVersion('0.1.0', 'v0.1.1')).toBe(true)
    expect(isNewerVersion('v0.2.0', 'v0.1.9')).toBe(false)
    expect(isNewerVersion('v1.0.0', 'v1.0.0')).toBe(false)
    expect(isNewerVersion('v0.9.9', 'v1.0.0')).toBe(true)
  })

  it('treats a -dev build as its base version (same release is not an update)', () => {
    expect(isNewerVersion('0.1.0-dev', 'v0.1.0')).toBe(false)
    expect(isNewerVersion('0.1.0-dev', 'v0.1.1')).toBe(true)
  })

  it('falls back to string inequality for unparseable versions', () => {
    expect(isNewerVersion('main', 'v1.0.0')).toBe(true)
    expect(isNewerVersion('abc', 'abc')).toBe(false)
  })
})

describe('extractTunnelAddress (playit tunnels-list parsing)', () => {
  it('finds a udp tunnel by local port (documented shape)', () => {
    const payload = {
      tunnels: [
        { proto: 'tcp', local_port: 25565, domain: 'mc.ply.gg', port_start: 25565 },
        { proto: 'udp', local_port: 8211, domain: 'craft.ply.gg', port_start: 52801 },
      ],
    }
    expect(extractTunnelAddress(payload, 8211)).toBe('craft.ply.gg:52801')
  })

  it('handles the data-wrapped + alloc shape', () => {
    const payload = {
      data: {
        tunnels: [
          {
            tunnel_type: 'udp',
            origin: { local_port: 8211 },
            alloc: { data: { assigned_domain: 'x.ply.gg', port_start: 41000 } },
          },
        ],
      },
    }
    expect(extractTunnelAddress(payload, 8211)).toBe('x.ply.gg:41000')
  })

  it('falls back to assigned_srv strings', () => {
    const payload = {
      tunnels: [{ port_type: 'both', alloc: { assigned_srv: 'y.ply.gg:9999' } }],
    }
    expect(extractTunnelAddress(payload, 8211)).toBe('y.ply.gg:9999')
  })

  it('returns null for tcp-only, wrong-port, or malformed payloads', () => {
    expect(
      extractTunnelAddress({ tunnels: [{ proto: 'tcp', local_port: 8211, domain: 'a', port_start: 1 }] }, 8211),
    ).toBeNull()
    expect(
      extractTunnelAddress({ tunnels: [{ proto: 'udp', local_port: 9999, domain: 'a', port_start: 1 }] }, 8211),
    ).toBeNull()
    expect(extractTunnelAddress(null, 8211)).toBeNull()
    expect(extractTunnelAddress({ nope: true }, 8211)).toBeNull()
  })
})

describe('public access reset (re-create the playit agent)', () => {
  const sink = { line: () => {}, progress: () => {} }

  it('reset drops the claim so enable re-runs the full claim flow', async () => {
    const svc = createFakePublicAccess()
    await svc.enable(sink)
    let s = await svc.status()
    expect(s.claimed).toBe(true)
    expect(s.running).toBe(true)
    expect(s.address).not.toBeNull()

    await svc.reset()
    s = await svc.status()
    expect(s.installed).toBe(true) // the binary stays; only the secret goes
    expect(s.claimed).toBe(false)
    expect(s.running).toBe(false)
    expect(s.address).toBeNull()
    expect(s.pendingClaim).toBeNull()

    // Enable again = complete re-create path.
    await svc.enable(sink)
    s = await svc.status()
    expect(s.claimed).toBe(true)
    expect(s.address).not.toBeNull()
  })
})

describe('readGamePort (per-server tunnel port)', () => {
  const instances = {
    list: () => [
      {
        id: 'srv-pal',
        installDir: '/opt/games/palworld',
        game: { settingsAdapter: 'none', ports: [{ name: 'game', port: 8211 }] },
      },
      {
        id: 'srv-ensh',
        installDir: '/opt/games/enshrouded',
        game: {
          settingsAdapter: 'none',
          ports: [
            { name: 'game', port: 15636 },
            { name: 'query', port: 15637, join: true },
          ],
        },
      },
    ],
  }

  it('scopes to the requested server, not the first instance', () => {
    expect(readGamePort(instances, 'srv-pal')).toBe(8211)
  })

  it("prefers a join-flagged port — Enshrouded connects over its query port", () => {
    expect(readGamePort(instances, 'srv-ensh')).toBe(15637)
  })

  it('falls back to the first server with a game port when unscoped', () => {
    expect(readGamePort(instances)).toBe(8211)
  })

  it('returns null for an unknown server id', () => {
    expect(readGamePort(instances, 'nope')).toBeNull()
  })
})

describe('parseA2sInfo (A2S query fallback)', () => {
  function buildInfoPacket(): Buffer {
    const c = (str: string) => Buffer.from(`${str}\0`, 'utf8')
    return Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 0x11]), // header, 0x49, protocol
      c('Rallypoint Enshrouded'), // name
      c('map'),
      c('enshrouded'),
      c('Enshrouded'),
      Buffer.from([0x6c, 0x22]), // appid int16
      Buffer.from([3, 16, 0]), // players, max, bots
      Buffer.from('dlwo', 'latin1'), // type, env, visibility, vac
      c('0.7.4.0'), // version
    ])
  }

  it('parses name, version and player counts from a source-format packet', () => {
    expect(parseA2sInfo(buildInfoPacket())).toEqual({
      name: 'Rallypoint Enshrouded',
      version: '0.7.4.0',
      players: 3,
      maxPlayers: 16,
    })
  })

  it('rejects non-INFO payloads', () => {
    expect(() => parseA2sInfo(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41, 1, 2, 3, 4]))).toThrowError(
      /not an A2S_INFO/,
    )
    expect(() => parseA2sInfo(Buffer.from('junk'))).toThrowError(/not an A2S_INFO/)
  })
})

describe('PlayitTrace (public-access console buffer)', () => {
  it('redacts registered secrets from every line', () => {
    const trace = new PlayitTrace()
    trace.redact('supersecretkey123')
    trace.add('api', 'POST /tunnels/list with agent-key supersecretkey123 failed')
    const lines = trace.list().map((e) => e.line).join('\n')
    expect(lines).not.toContain('supersecretkey123')
    expect(lines).toContain('[secret]')
  })

  it('caps the buffer at 100 entries', () => {
    const trace = new PlayitTrace()
    for (let i = 0; i < 150; i++) trace.add('helper', `line ${i}`)
    const list = trace.list()
    expect(list).toHaveLength(100)
    expect(list[0]!.line).toBe('line 50')
    expect(list[99]!.line).toBe('line 149')
  })
})
