import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RconError,
  SERVERDATA_AUTH_RESPONSE,
  SERVERDATA_RESPONSE_VALUE,
  decodePackets,
  encodePacket,
  rconExec,
} from './source-rcon.js'

// The transport is exercised against a real socket speaking the real
// framing — a hand-rolled protocol is exactly the kind of code that
// passes a self-referential test and fails on the wire.

interface FakeOptions {
  password: string
  // Response body, or several bodies to force a multi-packet reply.
  reply?: string | string[]
  // Answer the sentinel followup (a server that doesn't is a hang).
  echoSentinel?: boolean
  // Hang up right after auth without answering the command.
  dropAfterAuth?: boolean
}

const servers: net.Server[] = []

function startFakeRcon(opts: FakeOptions): Promise<number> {
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk])
      const { packets, rest } = decodePackets(pending)
      pending = rest
      for (const packet of packets) {
        // Auth: id echoed on success, -1 on failure.
        if (packet.type === 3) {
          socket.write(encodePacket(packet.id, SERVERDATA_RESPONSE_VALUE, ''))
          const ok = packet.body === opts.password
          socket.write(encodePacket(ok ? packet.id : -1, SERVERDATA_AUTH_RESPONSE, ''))
          if (!ok) socket.end()
          continue
        }
        if (opts.dropAfterAuth) {
          socket.end()
          continue
        }
        // An empty body is the sentinel followup, not a command.
        if (packet.body === '') {
          if (opts.echoSentinel !== false) {
            socket.write(encodePacket(packet.id, SERVERDATA_RESPONSE_VALUE, ''))
          }
          continue
        }
        const bodies = Array.isArray(opts.reply) ? opts.reply : [opts.reply ?? '']
        for (const body of bodies) {
          socket.write(encodePacket(packet.id, SERVERDATA_RESPONSE_VALUE, body))
        }
      }
    })
  })
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port)
    })
  })
}

afterEach(() => {
  while (servers.length > 0) servers.pop()!.close()
})

describe('packet framing', () => {
  it('round-trips through encode/decode', () => {
    const buf = encodePacket(7, 2, 'status')
    const { packets, rest } = decodePackets(buf)
    expect(packets).toEqual([{ id: 7, type: 2, body: 'status' }])
    expect(rest).toHaveLength(0)
  })

  it('sizes the packet as everything after the length field', () => {
    const buf = encodePacket(1, 3, 'pw')
    // 4 id + 4 type + 2 body + 2 NUL terminators.
    expect(buf.readInt32LE(0)).toBe(12)
    expect(buf).toHaveLength(16)
  })

  it('holds back a partial packet until the rest arrives', () => {
    const full = encodePacket(1, 0, 'hello')
    const first = decodePackets(full.subarray(0, 9))
    expect(first.packets).toEqual([])
    const second = decodePackets(Buffer.concat([first.rest, full.subarray(9)]))
    expect(second.packets).toEqual([{ id: 1, type: 0, body: 'hello' }])
  })

  it('splits several packets out of one chunk', () => {
    const chunk = Buffer.concat([encodePacket(1, 0, 'a'), encodePacket(2, 0, 'b')])
    expect(decodePackets(chunk).packets.map((p) => p.body)).toEqual(['a', 'b'])
  })

  it('rejects an absurd declared size instead of allocating on it', () => {
    const buf = Buffer.alloc(12)
    buf.writeInt32LE(99_000_000, 0)
    expect(() => decodePackets(buf)).toThrow(RconError)
  })
})

describe('rconExec', () => {
  it('authenticates and returns the command output', async () => {
    const port = await startFakeRcon({ password: 'secret', reply: 'hostname: Rallypoint' })
    await expect(rconExec('127.0.0.1', port, 'secret', 'status')).resolves.toBe('hostname: Rallypoint')
  })

  it('joins a multi-packet response in order', async () => {
    const port = await startFakeRcon({ password: 'secret', reply: ['part one ', 'part two'] })
    await expect(rconExec('127.0.0.1', port, 'secret', 'status')).resolves.toBe('part one part two')
  })

  it('reports a bad password rather than hanging', async () => {
    const port = await startFakeRcon({ password: 'secret' })
    await expect(rconExec('127.0.0.1', port, 'wrong', 'status')).rejects.toThrow(/authentication failed/)
  })

  it('rejects an empty password without opening a socket', async () => {
    await expect(rconExec('127.0.0.1', 1, '', 'status')).rejects.toThrow(/no RCON password/)
  })

  it('surfaces a refused connection', async () => {
    // Port 1 on loopback is not listening in any sane environment.
    await expect(rconExec('127.0.0.1', 1, 'secret', 'status')).rejects.toThrow(/connection failed/)
  })

  it('reports a server that hangs up mid-command', async () => {
    const port = await startFakeRcon({ password: 'secret', dropAfterAuth: true })
    await expect(rconExec('127.0.0.1', port, 'secret', 'status')).rejects.toThrow(/closed before/)
  })
})
