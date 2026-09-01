import dgram from 'node:dgram'
import type { PalServerInfo, PalServerMetrics } from '@rallypoint-cmd/shared'
import type { GameQuery } from './types.js'

// Satisfactory Lightweight Query API adapter — the read-only fallback
// for the 1.0 dedicated server, which answers on the *game* port (UDP
// 7777) rather than a separate query port. One packet in, one packet
// out: server name, net CL (version), run state. The protocol carries
// no player counts, so metrics() is empty and the dashboard renders the
// player stat as `—`. No player names, no announce/kick — those stay
// capability-gated off in the registry.

const MAGIC = 0xf6d5
const PROTOCOL_VERSION = 1
const MSG_POLL_SERVER_STATE = 0
const MSG_SERVER_STATE_RESPONSE = 1
const TERMINATOR = 0x1

export interface SatisfactoryState {
  cookie: bigint
  // 0 offline, 1 idle, 2 loading, 3 playing.
  state: number
  name: string
  netCL: number
  flags: bigint
}

// Build a Poll Server State request. The cookie is echoed back verbatim
// by the server, so it doubles as the match token for the reply.
export function buildPollRequest(cookie: bigint): Buffer {
  const buf = Buffer.alloc(13)
  buf.writeUInt16LE(MAGIC, 0)
  buf.writeUInt8(MSG_POLL_SERVER_STATE, 2)
  buf.writeUInt8(PROTOCOL_VERSION, 3)
  buf.writeBigUInt64LE(cookie, 4)
  buf.writeUInt8(TERMINATOR, 12)
  return buf
}

// Parse a Server State Response. Exported for fixture tests.
export function parseServerState(buf: Buffer): SatisfactoryState {
  if (buf.length < 4 || buf.readUInt16LE(0) !== MAGIC) throw new Error('not a Satisfactory LWQ response')
  if (buf[2] !== MSG_SERVER_STATE_RESPONSE) throw new Error(`unexpected LWQ message type ${buf[2]}`)
  if (buf[3] !== PROTOCOL_VERSION) throw new Error(`unsupported LWQ protocol version ${buf[3]}`)

  let off = 4
  const need = (n: number): void => {
    if (off + n > buf.length) throw new Error('truncated Satisfactory LWQ response')
  }

  need(8)
  const cookie = buf.readBigUInt64LE(off)
  off += 8
  need(1)
  const state = buf.readUInt8(off)
  off += 1
  need(4)
  const netCL = buf.readUInt32LE(off)
  off += 4
  need(8)
  const flags = buf.readBigUInt64LE(off)
  off += 8
  need(1)
  const numSubstates = buf.readUInt8(off)
  off += 1
  // Substates are versioned feature blobs we don't surface — skip them,
  // but walk the list so the name offset stays correct.
  need(numSubstates * 3)
  off += numSubstates * 3
  need(2)
  const nameLen = buf.readUInt16LE(off)
  off += 2
  need(nameLen)
  const name = buf.toString('utf8', off, off + nameLen)
  off += nameLen
  need(1)
  if (buf.readUInt8(off) !== TERMINATOR) throw new Error('missing Satisfactory LWQ terminator')

  return { cookie, state, name, netCL, flags }
}

function queryState(host: string, port: number, timeoutMs: number): Promise<SatisfactoryState> {
  return new Promise((resolve, reject) => {
    const cookie = BigInt(Date.now())
    const request = buildPollRequest(cookie)
    const sock = dgram.createSocket('udp4')
    let settled = false
    const finish = (err: Error | null, state?: SatisfactoryState): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.close()
      if (err) reject(err)
      else resolve(state!)
    }
    const timer = setTimeout(
      () => finish(new Error(`Satisfactory LWQ timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    sock.on('error', (err) => finish(err))
    sock.on('message', (msg) => {
      try {
        const state = parseServerState(msg)
        // A stale datagram from an earlier poll isn't an error — keep
        // waiting for ours (or for the timeout).
        if (state.cookie !== cookie) return
        finish(null, state)
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)))
      }
    })
    sock.send(request, port, host)
  })
}

export function createSatisfactoryQuery(gamePort: number, host = '127.0.0.1'): GameQuery {
  const TIMEOUT_MS = 3000
  return {
    async reachable() {
      try {
        await queryState(host, gamePort, TIMEOUT_MS)
        return true
      } catch {
        return false
      }
    },
    async info(): Promise<PalServerInfo> {
      const state = await queryState(host, gamePort, TIMEOUT_MS)
      return { servername: state.name || 'Satisfactory Server', version: String(state.netCL) }
    },
    // The protocol carries no player counts — an empty metrics object is
    // the honest answer, and the schema makes the counts optional.
    async metrics(): Promise<PalServerMetrics> {
      await queryState(host, gamePort, TIMEOUT_MS)
      return {}
    },
  }
}
