import type { Player } from '@rallypoint-cmd/shared'
import type { PlayerAdmin } from '../types.js'
import { RconError, rconExec } from '../source-rcon.js'

// PlayerAdmin over Source RCON. Everything game-specific lives in one
// table per slug: the commands to send and the parser for the list
// output. The transport (source-rcon.ts) knows nothing about games.

export interface RconCreds {
  port: number | null
  password: string | null
}

const HOST = '127.0.0.1'

// RCON has no argument escaping worth the name: a newline ends the
// command and an unbalanced quote swallows the rest of the line. Values
// that could do either are rejected rather than silently mangled.
export function sanitizeArg(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new RconError('empty RCON argument')
  if (/[\r\n\0;]/.test(trimmed)) throw new RconError('RCON argument contains a control character')
  return trimmed
}

// Message bodies are user text, so they are cleaned rather than
// rejected: newlines collapse to spaces and quotes are stripped.
export function sanitizeMessage(message: string): string {
  return message.replace(/[\r\n\0]+/g, ' ').replace(/"/g, '').trim()
}

function quoted(value: string): string {
  return `"${sanitizeArg(value).replace(/"/g, '')}"`
}

// --- parsers --------------------------------------------------------

// Source `status` rows:
// `# 2 "Alice" STEAM_1:0:1234 05:11 62 0 active 192.168.1.5:27005`
// CS2/newer TF2 builds also emit a `#end`/header preamble we skip.
const STATUS_ROW =
  /^#\s*(\d+)\s+(?:\d+\s+)?"(.*)"\s+(\S+)\s+([\d:]+)\s+(\d+)\s+(\d+)\s+(\w+)(?:\s+(\S+))?/

export function parseStatus(output: string): Player[] {
  const players: Player[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = STATUS_ROW.exec(line.trim())
    if (!m) continue
    const [, userid, name, uniqueid, , ping, , , addr] = m
    if (userid === undefined || name === undefined || uniqueid === undefined) continue
    // The `# userid name uniqueid` header row matches the shape too.
    if (uniqueid === 'uniqueid') continue
    const ip = addr?.includes(':') ? addr.split(':')[0] : undefined
    players.push({
      name,
      playerId: userid,
      userId: uniqueid,
      ...(ping !== undefined ? { ping: Number(ping) } : {}),
      ...(ip ? { ip } : {}),
    })
  }
  return players
}

// ARK `listplayers`: `0. PlayerName, 76561198000000000`
const ARK_ROW = /^\s*(\d+)\.\s+(.*?),\s*(\d{5,})\s*$/

export function parseListPlayers(output: string): Player[] {
  const players: Player[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = ARK_ROW.exec(line)
    if (!m) continue
    const [, index, name, steamId] = m
    if (index === undefined || name === undefined || steamId === undefined) continue
    players.push({ name: name.trim(), playerId: index, userId: steamId })
  }
  return players
}

// Project Zomboid `players`:
// `Players connected (2):` then `-Alice` / `-Bob`.
export function parseZomboidPlayers(output: string): Player[] {
  const players: Player[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /players connected/i.test(line)) continue
    const name = line.startsWith('-') ? line.slice(1).trim() : line
    if (!name) continue
    // PZ identifies players by username everywhere — there is no steamid
    // in this output, so the name is both ids.
    players.push({ name, playerId: name, userId: name })
  }
  return players
}

// --- per-slug tables -------------------------------------------------

interface RconGame {
  parse(output: string): Player[]
  list: string
  kick(userId: string, message?: string): string
  ban(userId: string, message?: string): string
  unban(userId: string): string
  announce(message: string): string
  save: string | null
}

// Source games identify a session by the numeric userid for kick/ban but
// by SteamID for unban, which is why kick/ban take the id the list
// surfaced as playerId. The route hands back whatever `userId` the
// player row carried, so both forms are accepted here.
const SOURCE: RconGame = {
  parse: parseStatus,
  list: 'status',
  kick: (userId) => `kickid ${sanitizeArg(userId)}`,
  ban: (userId) => `banid 0 ${sanitizeArg(userId)} kick`,
  unban: (userId) => `removeid ${sanitizeArg(userId)}`,
  announce: (message) => `say ${sanitizeMessage(message)}`,
  save: null,
}

const TABLES: Record<string, RconGame> = {
  'team-fortress-2': SOURCE,
  'counter-strike-2': SOURCE,
  'ark-survival-evolved': {
    parse: parseListPlayers,
    list: 'listplayers',
    kick: (userId) => `kickplayer ${sanitizeArg(userId)}`,
    ban: (userId) => `banplayer ${sanitizeArg(userId)}`,
    unban: (userId) => `unbanplayer ${sanitizeArg(userId)}`,
    announce: (message) => `broadcast ${sanitizeMessage(message)}`,
    save: 'saveworld',
  },
  'project-zomboid': {
    parse: parseZomboidPlayers,
    list: 'players',
    kick: (userId) => `kickuser ${quoted(userId)}`,
    ban: (userId) => `banuser ${quoted(userId)}`,
    unban: (userId) => `unbanuser ${quoted(userId)}`,
    announce: (message) => `servermsg "${sanitizeMessage(message)}"`,
    save: 'save',
  },
}

export function createRconAdmin(slug: string, getCreds: () => RconCreds): PlayerAdmin {
  const table = TABLES[slug]
  if (!table) throw new RconError(`no RCON command table for ${slug}`)

  async function exec(command: string): Promise<string> {
    const { port, password } = getCreds()
    if (!port) throw new RconError(`${slug} has no RCON port configured`)
    if (!password) throw new RconError(`${slug} has no RCON password configured`)
    return rconExec(HOST, port, password, command)
  }

  return {
    players: async () => table.parse(await exec(table.list)),
    announce: async (message) => {
      await exec(table.announce(message))
    },
    kick: async (userId, message) => {
      await exec(table.kick(userId, message))
    },
    ban: async (userId, message) => {
      await exec(table.ban(userId, message))
    },
    unban: async (userId) => {
      await exec(table.unban(userId))
    },
    save: async () => {
      const command = table.save
      // Defensive: the route 404s on an unsupported action first.
      if (!command) throw new RconError(`${slug} does not support save over RCON`)
      await exec(command)
    },
  }
}
