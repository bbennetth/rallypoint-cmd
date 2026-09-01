import { describe, expect, it } from 'vitest'
import { buildPollRequest, parseServerState } from './satisfactory-lwq.real.js'

interface ResponseFixture {
  cookie?: bigint
  state?: number
  netCL?: number
  flags?: bigint
  substates?: { id: number; version: number }[]
  name?: string
  messageType?: number
  protocol?: number
  terminator?: number
}

// Hand-build a Server State Response so the parser is exercised against
// the wire layout, not against itself.
function buildResponse(f: ResponseFixture = {}): Buffer {
  const {
    cookie = 1234567890n,
    state = 3,
    netCL = 368883,
    flags = 0n,
    substates = [],
    name = 'Rallypoint Factory',
    messageType = 1,
    protocol = 1,
    terminator = 0x1,
  } = f
  const nameBuf = Buffer.from(name, 'utf8')
  const buf = Buffer.alloc(4 + 8 + 1 + 4 + 8 + 1 + substates.length * 3 + 2 + nameBuf.length + 1)
  let off = 0
  buf.writeUInt16LE(0xf6d5, off)
  off += 2
  buf.writeUInt8(messageType, off++)
  buf.writeUInt8(protocol, off++)
  buf.writeBigUInt64LE(cookie, off)
  off += 8
  buf.writeUInt8(state, off++)
  buf.writeUInt32LE(netCL, off)
  off += 4
  buf.writeBigUInt64LE(flags, off)
  off += 8
  buf.writeUInt8(substates.length, off++)
  for (const s of substates) {
    buf.writeUInt8(s.id, off++)
    buf.writeUInt16LE(s.version, off)
    off += 2
  }
  buf.writeUInt16LE(nameBuf.length, off)
  off += 2
  nameBuf.copy(buf, off)
  off += nameBuf.length
  buf.writeUInt8(terminator, off)
  return buf
}

describe('buildPollRequest', () => {
  it('encodes magic, message type, protocol, cookie and terminator', () => {
    const req = buildPollRequest(0xdeadbeefn)
    expect(req).toHaveLength(13)
    expect(req.readUInt16LE(0)).toBe(0xf6d5)
    expect(req.readUInt8(2)).toBe(0) // Poll Server State
    expect(req.readUInt8(3)).toBe(1) // protocol version
    expect(req.readBigUInt64LE(4)).toBe(0xdeadbeefn)
    expect(req.readUInt8(12)).toBe(0x1)
  })
})

describe('parseServerState', () => {
  it('parses a response with no substates', () => {
    const parsed = parseServerState(buildResponse())
    expect(parsed).toEqual({
      cookie: 1234567890n,
      state: 3,
      netCL: 368883,
      flags: 0n,
      name: 'Rallypoint Factory',
    })
  })

  it('skips substates so the server name still lands', () => {
    const parsed = parseServerState(
      buildResponse({
        substates: [
          { id: 1, version: 7 },
          { id: 2, version: 65535 },
          { id: 9, version: 0 },
        ],
        name: 'Substated',
      }),
    )
    expect(parsed.name).toBe('Substated')
    expect(parsed.netCL).toBe(368883)
  })

  it('reads UTF-8 server names by byte length', () => {
    expect(parseServerState(buildResponse({ name: 'Fábrica ☭ 工場' })).name).toBe('Fábrica ☭ 工場')
  })

  it('round-trips the request cookie', () => {
    const cookie = 1735689600000n
    expect(parseServerState(buildResponse({ cookie })).cookie).toBe(cookie)
  })

  it('reports the idle and loading run states', () => {
    expect(parseServerState(buildResponse({ state: 1 })).state).toBe(1)
    expect(parseServerState(buildResponse({ state: 2 })).state).toBe(2)
  })

  it('rejects a foreign magic', () => {
    const buf = buildResponse()
    buf.writeUInt16LE(0x1234, 0)
    expect(() => parseServerState(buf)).toThrow(/not a Satisfactory LWQ response/)
  })

  it('rejects the wrong message type', () => {
    expect(() => parseServerState(buildResponse({ messageType: 0 }))).toThrow(/unexpected LWQ message type/)
  })

  it('rejects an unknown protocol version', () => {
    expect(() => parseServerState(buildResponse({ protocol: 2 }))).toThrow(/unsupported LWQ protocol version/)
  })

  it('rejects a missing terminator', () => {
    expect(() => parseServerState(buildResponse({ terminator: 0 }))).toThrow(/missing Satisfactory LWQ terminator/)
  })

  it('rejects a truncated payload', () => {
    const buf = buildResponse()
    expect(() => parseServerState(buf.subarray(0, buf.length - 5))).toThrow(/truncated/)
  })
})
