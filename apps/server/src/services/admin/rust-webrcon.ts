import type { Player } from '@rallypoint-cmd/shared'
import type { PlayerAdmin } from '../types.js'
import { sanitizeArg, sanitizeMessage, type RconCreds } from './rcon-admin.js'

// Rust speaks its own WebSocket RCON rather than Source RCON: the
// password is the URL path, frames are JSON, and replies are matched to
// requests by Identifier. Uses Node's global WebSocket (stable since
// Node 22, which is this repo's engines floor).

const TIMEOUT_MS = 5000

export class WebrconError extends Error {}

interface WebrconFrame {
  Identifier?: number
  Message?: string
  Type?: string
}

// `playerlist` answers with a JSON array in Message.
interface RustPlayerRow {
  SteamID?: string | number
  DisplayName?: string
  Ping?: number
  Address?: string
  Health?: number
}

// A 17-digit SteamID is past Number.MAX_SAFE_INTEGER, so a build that
// emits it unquoted would lose its last digits in JSON.parse — and the
// panel would then kick or ban an id nobody holds. Quote those fields
// before parsing so the value survives as text either way.
function quoteBigIds(json: string): string {
  return json.replace(/("(?:SteamID|OwnerSteamID)"\s*:\s*)(\d{16,})/g, '$1"$2"')
}

export function parsePlayerList(message: string): Player[] {
  let rows: unknown
  try {
    rows = JSON.parse(quoteBigIds(message))
  } catch {
    throw new WebrconError('playerlist did not return JSON')
  }
  if (!Array.isArray(rows)) return []
  return (rows as RustPlayerRow[]).map((row) => {
    const steamId = row.SteamID === undefined ? '' : String(row.SteamID)
    const ip = row.Address?.split(':')[0]
    return {
      name: row.DisplayName ?? steamId,
      playerId: steamId,
      userId: steamId,
      ...(typeof row.Ping === 'number' ? { ping: row.Ping } : {}),
      ...(ip ? { ip } : {}),
    }
  })
}

export function rustExec(port: number, password: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const identifier = Math.floor(Math.random() * 0x7fffffff) + 1
    let socket: WebSocket
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}/${encodeURIComponent(password)}`)
    } catch {
      // Deliberately not including the underlying message: the password
      // is in the URL, and URL errors quote the URL.
      reject(new WebrconError('Rust RCON connect failed (bad port or password?)'))
      return
    }
    let done = false
    const finish = (err: Error | null, value?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // Already closing — nothing to do.
      }
      if (err) reject(err)
      else resolve(value ?? '')
    }
    const timer = setTimeout(() => {
      finish(new WebrconError(`Rust RCON timed out after ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)

    socket.onopen = () => {
      socket.send(JSON.stringify({ Identifier: identifier, Message: command, Name: 'WebRcon' }))
    }
    socket.onerror = () => {
      // The browser-style event carries no cause; a bad password shows up
      // here as a refused handshake.
      finish(new WebrconError('Rust RCON connection failed (port or password wrong?)'))
    }
    socket.onclose = () => {
      finish(new WebrconError('Rust RCON connection closed before a reply arrived'))
    }
    socket.onmessage = (event: MessageEvent) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data)
      let frame: WebrconFrame
      try {
        frame = JSON.parse(raw) as WebrconFrame
      } catch {
        return
      }
      // Rust broadcasts console chatter on Identifier 0; ignore it.
      if (frame.Identifier !== identifier) return
      finish(null, frame.Message ?? '')
    }
  })
}

export function createRustWebrcon(getCreds: () => RconCreds): PlayerAdmin {
  async function exec(command: string): Promise<string> {
    const { port, password } = getCreds()
    if (!port) throw new WebrconError('rust has no RCON port configured')
    if (!password) throw new WebrconError('rust has no RCON password configured')
    return rustExec(port, password, command)
  }

  return {
    players: async () => parsePlayerList(await exec('playerlist')),
    announce: async (message) => {
      await exec(`say "${sanitizeMessage(message)}"`)
    },
    kick: async (userId) => {
      await exec(`kick ${sanitizeArg(userId)}`)
    },
    ban: async (userId, message) => {
      // Rust's `banid` signature is <id> <username> <reason>; `ban` takes
      // the id with just a reason, which is all the panel has.
      await exec(`ban ${sanitizeArg(userId)} "${sanitizeMessage(message ?? 'Banned by an admin')}"`)
    },
    unban: async (userId) => {
      await exec(`unban ${sanitizeArg(userId)}`)
    },
    save: async () => {
      await exec('server.save')
    },
  }
}
