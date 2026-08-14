import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GAMES } from '@rallypoint-cmd/shared'
import {
  ALLOWED_UNITS,
  JOURNALCTL_BIN,
  SYSTEMCTL_BIN,
  SYSTEMCTL_VERBS,
  journalctlTailArgs,
} from './constants.js'
import { parseSystemdTimestamp } from './game-control.real.js'
import { decideSteamcmdOutcome } from './steamcmd.real.js'
import { isNewerVersion } from './panel-update.js'
import { extractTunnelAddress, PlayitTrace } from './public-access.js'

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

describe('sudoers drift (deploy/sudoers/rallypoint-cmd vs code)', () => {
  // The panel only ever runs `sudo systemctl <verb> <unit>` and
  // `sudo journalctl -u <unit> -n 500 -o cat -f` for units in
  // ALLOWED_UNITS. The sudoers file must pin exactly those argv lines.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const sudoersPath = path.resolve(here, '../../../../deploy/sudoers/rallypoint-cmd')
  const content = fs.readFileSync(sudoersPath, 'utf8')

  it('pins every allowed unit for all three systemctl verbs + journalctl tail', () => {
    for (const unit of ALLOWED_UNITS) {
      for (const verb of SYSTEMCTL_VERBS) {
        expect(content).toContain(
          `rallypoint ALL=(root) NOPASSWD: ${SYSTEMCTL_BIN} ${verb} ${unit}`,
        )
      }
      expect(content).toContain(
        `rallypoint ALL=(root) NOPASSWD: ${JOURNALCTL_BIN} ${journalctlTailArgs(unit).join(' ')}`,
      )
    }
  })

  it('every privileged rule uses the rallypoint principal (no leftover palworld user)', () => {
    for (const line of content.split('\n')) {
      if (line.includes('ALL=(root)')) expect(line.startsWith('rallypoint ')).toBe(true)
    }
  })

  it('grants no unit lines beyond the allowed set (wildcard-free)', () => {
    const unitLines = content
      .split('\n')
      .filter((l) => l.includes(SYSTEMCTL_BIN) || l.includes(JOURNALCTL_BIN))
    expect(unitLines.length).toBe(ALLOWED_UNITS.length * (SYSTEMCTL_VERBS.length + 1))
    for (const line of unitLines) {
      expect(line).not.toContain('*')
      expect(ALLOWED_UNITS.some((u) => line.includes(` ${u}`))).toBe(true)
    }
  })

  it('helper script knows every registry slug', () => {
    const helper = fs.readFileSync(
      path.resolve(here, '../../../../deploy/bin/rallypoint-cmd-game'),
      'utf8',
    )
    for (const slug of Object.keys(GAMES)) {
      expect(helper).toContain(`${slug})`)
    }
  })
})
