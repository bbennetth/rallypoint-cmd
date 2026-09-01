import { describe, expect, it } from 'vitest'
import { RconError } from '../source-rcon.js'
import { parseListPlayers, parseStatus, parseZomboidPlayers, sanitizeArg, sanitizeMessage } from './rcon-admin.js'
import { parsePlayerList } from './rust-webrcon.js'

// Console output is the only contract these games offer, and it is
// whitespace-formatted text that shifts between builds. The fixtures are
// verbatim samples so a parser regression is visible as a diff.

describe('parseStatus (TF2 / CS2)', () => {
  const OUTPUT = [
    'hostname: Rallypoint TF2',
    'version : 9235414/24 9235414 secure',
    'udp/ip  : 10.0.0.5:27015',
    'players : 2 humans, 0 bots (24 max)',
    '# userid name uniqueid connected ping loss state adr',
    '# 2 "Alice" [U:1:1234567] 05:11 62 0 active 10.0.0.9:27005',
    '# 3 "Bob The Builder" [U:1:7654321] 01:02 84 1 active 10.0.0.11:27005',
  ].join('\n')

  it('reads userid, name, steam id and ping', () => {
    expect(parseStatus(OUTPUT)).toEqual([
      { name: 'Alice', playerId: '2', userId: '[U:1:1234567]', ping: 62, ip: '10.0.0.9' },
      { name: 'Bob The Builder', playerId: '3', userId: '[U:1:7654321]', ping: 84, ip: '10.0.0.11' },
    ])
  })

  it('ignores the header and preamble rows', () => {
    expect(parseStatus(OUTPUT).some((p) => p.name === 'name')).toBe(false)
  })

  it('returns nothing for an empty server', () => {
    expect(parseStatus('hostname: Rallypoint\n# userid name uniqueid connected ping loss state adr')).toEqual([])
  })
})

describe('parseListPlayers (ARK)', () => {
  it('reads the numbered name, steamid rows', () => {
    const output = ['0. Alice, 76561198000000001', '1. Bob The Builder, 76561198000000002'].join('\n')
    expect(parseListPlayers(output)).toEqual([
      { name: 'Alice', playerId: '0', userId: '76561198000000001' },
      { name: 'Bob The Builder', playerId: '1', userId: '76561198000000002' },
    ])
  })

  it('returns nothing for ARK’s empty-server reply', () => {
    expect(parseListPlayers('No Players Connected')).toEqual([])
  })
})

describe('parseZomboidPlayers', () => {
  it('reads the dashed name list', () => {
    expect(parseZomboidPlayers('Players connected (2):\n-Alice\n-Bob')).toEqual([
      { name: 'Alice', playerId: 'Alice', userId: 'Alice' },
      { name: 'Bob', playerId: 'Bob', userId: 'Bob' },
    ])
  })

  it('returns nothing when nobody is connected', () => {
    expect(parseZomboidPlayers('Players connected (0):')).toEqual([])
  })
})

describe('parsePlayerList (Rust webrcon)', () => {
  it('reads the JSON array Rust answers with', () => {
    // Raw text, not JSON.stringify of a JS literal: a 17-digit id in
    // source would already be rounded before it reached the parser.
    const message =
      '[{"SteamID":"76561198000000001","DisplayName":"Alice","Ping":31,"Address":"10.0.0.9:52001"},' +
      '{"SteamID":"76561198000000002","DisplayName":"Bob","Ping":55}]'
    expect(parsePlayerList(message)).toEqual([
      { name: 'Alice', playerId: '76561198000000001', userId: '76561198000000001', ping: 31, ip: '10.0.0.9' },
      { name: 'Bob', playerId: '76561198000000002', userId: '76561198000000002', ping: 55 },
    ])
  })

  it('treats an empty list as nobody online', () => {
    expect(parsePlayerList('[]')).toEqual([])
  })

  it('keeps an unquoted 17-digit steam id exact', () => {
    // Past Number.MAX_SAFE_INTEGER: parsed as a number this would come
    // back ...000 and the panel would moderate an id nobody holds.
    const [player] = parsePlayerList('[{"SteamID":76561198000000002,"DisplayName":"Bob"}]')
    expect(player?.userId).toBe('76561198000000002')
  })

  it('rejects non-JSON output rather than returning junk players', () => {
    expect(() => parsePlayerList('Command not found')).toThrow(/did not return JSON/)
  })
})

describe('argument sanitizing', () => {
  it('rejects control characters that would end the command line', () => {
    for (const bad of ['alice\nkick bob', 'alice\rsay pwned', 'alice;quit', 'alice\0']) {
      expect(() => sanitizeArg(bad)).toThrow(RconError)
    }
  })

  it('rejects an empty argument', () => {
    expect(() => sanitizeArg('   ')).toThrow(RconError)
  })

  it('keeps a normal steam id intact', () => {
    expect(sanitizeArg(' 76561198000000001 ')).toBe('76561198000000001')
  })

  it('flattens broadcast text instead of rejecting it', () => {
    expect(sanitizeMessage('Restart in 5\nminutes "now"')).toBe('Restart in 5 minutes now')
  })
})
