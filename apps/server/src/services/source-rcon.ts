import net from 'node:net'

// Minimal Source RCON client (Valve's protocol, also spoken by ARK and
// Project Zomboid). One TCP connection per command: RCON servers drop
// sessions across game restarts and give no reliable keepalive, so a
// short-lived connection is both simpler and more robust than pooling.
//
// Packet layout, all little-endian:
//   int32 size (of everything after this field)
//   int32 id
//   int32 type
//   body (ASCII, NUL-terminated)
//   NUL terminator for the packet

const TIMEOUT_MS = 5000

export const SERVERDATA_AUTH = 3
export const SERVERDATA_AUTH_RESPONSE = 2
export const SERVERDATA_EXECCOMMAND = 2
export const SERVERDATA_RESPONSE_VALUE = 0

const AUTH_ID = 1
const EXEC_ID = 2
// Sentinel followup: the server echoes an empty RESPONSE_VALUE for it
// only after every packet of the real response has been sent, which is
// how multi-packet replies are known to be complete.
const SENTINEL_ID = 3

export class RconError extends Error {}

export interface RconPacket {
  id: number
  type: number
  body: string
}

export function encodePacket(id: number, type: number, body: string): Buffer {
  const payload = Buffer.from(body, 'utf8')
  const buf = Buffer.alloc(14 + payload.length)
  buf.writeInt32LE(10 + payload.length, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  payload.copy(buf, 12)
  // Two trailing NULs: body terminator + packet terminator.
  buf.writeUInt8(0, 12 + payload.length)
  buf.writeUInt8(0, 13 + payload.length)
  return buf
}

// Pulls whole packets off a growing buffer; returns the packets read and
// the unconsumed remainder.
export function decodePackets(buf: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = []
  let offset = 0
  while (buf.length - offset >= 4) {
    const size = buf.readInt32LE(offset)
    if (size < 10 || size > 4 * 1024 * 1024) throw new RconError(`bad RCON packet size ${size}`)
    if (buf.length - offset - 4 < size) break
    const id = buf.readInt32LE(offset + 4)
    const type = buf.readInt32LE(offset + 8)
    // size counts id + type + body + 2 NULs.
    const body = buf.toString('utf8', offset + 12, offset + 4 + size - 2)
    packets.push({ id, type, body })
    offset += 4 + size
  }
  return { packets, rest: buf.subarray(offset) }
}

export function rconExec(
  host: string,
  port: number,
  password: string,
  command: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!password) {
      reject(new RconError('no RCON password configured'))
      return
    }
    const socket = net.createConnection({ host, port })
    socket.setNoDelay(true)
    let pending: Buffer = Buffer.alloc(0)
    let authed = false
    let sentinelSent = false
    let done = false
    const chunks: string[] = []

    const finish = (err: Error | null, value?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      if (err) reject(err)
      else resolve(value ?? '')
    }

    const timer = setTimeout(() => {
      finish(new RconError(`RCON timed out after ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)

    socket.on('error', (err) => {
      finish(new RconError(`RCON connection failed: ${err.message}`))
    })
    socket.on('close', () => {
      // A clean close mid-command still means we never saw the sentinel.
      finish(new RconError('RCON connection closed before the response completed'))
    })

    socket.on('connect', () => {
      socket.write(encodePacket(AUTH_ID, SERVERDATA_AUTH, password))
    })

    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      let packets: RconPacket[]
      try {
        ;({ packets, rest: pending } = decodePackets(pending))
      } catch (err) {
        finish(err instanceof Error ? err : new RconError(String(err)))
        return
      }
      for (const packet of packets) {
        if (!authed) {
          // Servers precede AUTH_RESPONSE with an empty RESPONSE_VALUE.
          if (packet.type === SERVERDATA_RESPONSE_VALUE) continue
          if (packet.type !== SERVERDATA_AUTH_RESPONSE) continue
          if (packet.id === -1) {
            finish(new RconError('RCON authentication failed (bad password)'))
            return
          }
          authed = true
          socket.write(encodePacket(EXEC_ID, SERVERDATA_EXECCOMMAND, command))
          socket.write(encodePacket(SENTINEL_ID, SERVERDATA_EXECCOMMAND, ''))
          sentinelSent = true
          continue
        }
        if (!sentinelSent) continue
        if (packet.id === SENTINEL_ID) {
          finish(null, chunks.join(''))
          return
        }
        if (packet.id === EXEC_ID) chunks.push(packet.body)
      }
    })
  })
}
