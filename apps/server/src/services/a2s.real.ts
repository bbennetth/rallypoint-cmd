import dgram from 'node:dgram'
import type { PalServerInfo, PalServerMetrics } from '@rallypoint-cmd/shared'
import type { GameQuery } from './types.js'

// Steam A2S_INFO query adapter — the read-only fallback for games with a
// UDP query port but no admin API (Enshrouded). One packet in, one
// packet out: server name, game version, player count / capacity. No
// player names, no fps, no announce/kick — those stay capability-gated
// off in the registry.

const A2S_INFO_REQUEST = Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
  Buffer.from('Source Engine Query\0', 'latin1'),
])

export interface A2sInfo {
  name: string
  version: string
  players: number
  maxPlayers: number
}

// Parse an A2S_INFO (0x49, "Source" format) response payload. Exported
// for fixture tests.
export function parseA2sInfo(buf: Buffer): A2sInfo {
  if (buf.length < 6 || buf.readInt32LE(0) !== -1 || buf[4] !== 0x49) {
    throw new Error('not an A2S_INFO response')
  }
  let off = 6 // header + protocol byte
  const cstring = (): string => {
    const end = buf.indexOf(0, off)
    if (end === -1) throw new Error('truncated A2S_INFO string')
    const s = buf.toString('utf8', off, end)
    off = end + 1
    return s
  }
  const name = cstring()
  cstring() // map
  cstring() // folder
  cstring() // game
  off += 2 // appid (int16)
  if (off + 2 > buf.length) throw new Error('truncated A2S_INFO counts')
  const players = buf[off]!
  const maxPlayers = buf[off + 1]!
  off += 3 // players, max players, bots
  off += 4 // server type, environment, visibility, vac
  const version = off < buf.length ? cstring() : ''
  return { name, version, players, maxPlayers }
}

function queryInfo(host: string, port: number, timeoutMs: number): Promise<A2sInfo> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4')
    let settled = false
    const finish = (err: Error | null, info?: A2sInfo): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.close()
      if (err) reject(err)
      else resolve(info!)
    }
    const timer = setTimeout(() => finish(new Error(`A2S_INFO timed out after ${timeoutMs}ms`)), timeoutMs)
    sock.on('error', (err) => finish(err))
    sock.on('message', (msg) => {
      // 0x41 = challenge: resend the request with the 4 challenge bytes.
      if (msg.length >= 9 && msg.readInt32LE(0) === -1 && msg[4] === 0x41) {
        sock.send(Buffer.concat([A2S_INFO_REQUEST, msg.subarray(5, 9)]), port, host)
        return
      }
      try {
        finish(null, parseA2sInfo(msg))
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)))
      }
    })
    sock.send(A2S_INFO_REQUEST, port, host)
  })
}

export function createA2sQuery(queryPort: number, host = '127.0.0.1'): GameQuery {
  const TIMEOUT_MS = 3000
  const unavailable = (): never => {
    throw new Error('A2S query is read-only — this game has no admin API.')
  }
  return {
    async reachable() {
      try {
        await queryInfo(host, queryPort, TIMEOUT_MS)
        return true
      } catch {
        return false
      }
    },
    async info(): Promise<PalServerInfo> {
      const a2s = await queryInfo(host, queryPort, TIMEOUT_MS)
      return { servername: a2s.name, version: a2s.version }
    },
    async metrics(): Promise<PalServerMetrics> {
      const a2s = await queryInfo(host, queryPort, TIMEOUT_MS)
      return { currentplayernum: a2s.players, maxplayernum: a2s.maxPlayers }
    },
    players: unavailable,
    announce: unavailable,
    kick: unavailable,
    ban: unavailable,
    unban: unavailable,
    save: unavailable,
  }
}
