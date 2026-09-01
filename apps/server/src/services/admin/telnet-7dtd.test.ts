import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { TelnetError, create7dtdTelnet, parseListPlayers, telnetExec } from './telnet-7dtd.js'

// 7DTD's console has no framing at all, so the client's real risk is the
// handshake and the "output has gone quiet" heuristic — both exercised
// here against a socket that talks like the game does.

const LP_OUTPUT = [
  '1. id=171, Alice, pos=(-45.2, 61.0, 128.9), rot=(0.0, 92.6, 0.0), remote=True, health=100, deaths=0, zombies=12, players=1, score=42, level=7, steamid=76561198000000001, ip=10.0.0.9, ping=30',
  '2. id=172, Bob The Builder, pos=(12.0, 61.0, 8.0), rot=(0.0, 0.0, 0.0), remote=True, health=87, deaths=2, zombies=3, players=1, score=9, level=2, steamid=76561198000000002, ip=10.0.0.11, ping=48',
  'Total of 2 in the game',
].join('\r\n')

const servers: net.Server[] = []

interface FakeOptions {
  password: string
  reply?: string
  // Answer the password prompt with a rejection instead of a logon.
  rejectAuth?: boolean
}

function startFakeTelnet(opts: FakeOptions): Promise<number> {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let gotPassword = false
    socket.write('*** Connected with 7DTD server.\r\nPlease enter password:\r\n')
    socket.on('data', (chunk: string) => {
      const line = chunk.trim()
      if (!gotPassword) {
        gotPassword = true
        if (opts.rejectAuth || line !== opts.password) {
          socket.write('Password incorrect, please enter password:\r\n')
          return
        }
        socket.write('Logon successful.\r\nServer may have to wait for a moment.\r\n')
        return
      }
      socket.write(`${opts.reply ?? ''}\r\n`)
    })
  })
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
  })
}

afterEach(() => {
  while (servers.length > 0) servers.pop()!.close()
})

describe('parseListPlayers', () => {
  it('reads name, steam id, ping and level off an lp row', () => {
    expect(parseListPlayers(LP_OUTPUT)).toEqual([
      { name: 'Alice', playerId: '171', userId: '76561198000000001', ping: 30, level: 7, ip: '10.0.0.9' },
      { name: 'Bob The Builder', playerId: '172', userId: '76561198000000002', ping: 48, level: 2, ip: '10.0.0.11' },
    ])
  })

  it('falls back to the platform id newer builds report', () => {
    const row =
      '1. id=171, Alice, pos=(0,0,0), rot=(0,0,0), remote=True, health=100, deaths=0, zombies=0, players=0, score=0, level=1, pltfmid=Steam_76561198000000009, ip=10.0.0.9, ping=12'
    expect(parseListPlayers(row)[0]?.userId).toBe('76561198000000009')
  })

  it('ignores the trailing total line and an empty server', () => {
    expect(parseListPlayers('Total of 0 in the game')).toEqual([])
  })
})

describe('telnetExec', () => {
  it('authenticates and returns the command output', async () => {
    const port = await startFakeTelnet({ password: 'hunter2', reply: LP_OUTPUT })
    const out = await telnetExec('127.0.0.1', port, 'hunter2', 'lp')
    expect(out).toContain('id=171')
    expect(parseListPlayers(out)).toHaveLength(2)
  })

  it('reports a rejected password instead of waiting for the timeout', async () => {
    const port = await startFakeTelnet({ password: 'hunter2', rejectAuth: true })
    await expect(telnetExec('127.0.0.1', port, 'wrong', 'lp')).rejects.toThrow(/authentication failed/)
  })

  it('rejects an empty password without opening a socket', async () => {
    await expect(telnetExec('127.0.0.1', 1, '', 'lp')).rejects.toThrow(TelnetError)
  })

  it('surfaces a refused connection', async () => {
    await expect(telnetExec('127.0.0.1', 1, 'hunter2', 'lp')).rejects.toThrow(/connection failed|timed out/)
  })
})

describe('create7dtdTelnet', () => {
  it('lists players end to end through the admin interface', async () => {
    const port = await startFakeTelnet({ password: 'hunter2', reply: LP_OUTPUT })
    const admin = create7dtdTelnet(() => ({ port, password: 'hunter2' }))
    const players = await admin.players()
    expect(players.map((p) => p.name)).toEqual(['Alice', 'Bob The Builder'])
  })

  it('refuses to act when the panel has no credentials yet', async () => {
    const admin = create7dtdTelnet(() => ({ port: null, password: null }))
    await expect(admin.players()).rejects.toThrow(/no telnet port/)
  })
})
