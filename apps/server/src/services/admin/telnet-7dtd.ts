import net from 'node:net'
import type { Player } from '@rallypoint-cmd/shared'
import type { PlayerAdmin } from '../types.js'
import { sanitizeArg, sanitizeMessage, type RconCreds } from './rcon-admin.js'

// 7 Days to Die has no RCON — its admin channel is a plain telnet
// console. There is no framing and no response terminator: the server
// streams lines and stops when it has nothing more to say, so a command
// is "done" once the output goes quiet. One connection per command, same
// as the RCON client and for the same reason.

const CONNECT_TIMEOUT_MS = 5000
const COMMAND_TIMEOUT_MS = 7000
// How long the stream must stay silent before the reply counts as
// complete. Long enough to survive a slow tick, short enough that the
// Players page doesn't feel stuck.
const IDLE_GAP_MS = 400
// 7DTD streams the server log to every telnet client, so on a busy server
// the stream may never go quiet. Commands that have a real terminator are
// matched on it instead of waiting for silence.
const TERMINATORS = [/^Total of \d+ in the game$/m]
const MAX_OUTPUT_BYTES = 512 * 1024

export class TelnetError extends Error {}

// `1. id=171, Alice, pos=(-45.2, 61.0, 128.9), rot=(...), remote=True,
//  health=100, deaths=0, zombies=12, players=1, score=42, level=7,
//  steamid=76561198000000000, ip=10.0.0.5, ping=30`
//
// V1.0 replaced `steamid=` with the platform-qualified `pltfmid=Steam_…`
// (and `crossid=EOS_…`), so the fallback below is load-bearing on current
// builds — do not simplify it away.
const LP_ROW = /^\s*\d+\.\s+id=(\d+),\s*(.*?),\s*pos=/

function field(line: string, key: string): string | undefined {
  return line.match(new RegExp(`\\b${key}=([^,\\s]+)`))?.[1]
}

export function parseListPlayers(output: string): Player[] {
  const players: Player[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = LP_ROW.exec(line)
    if (!m) continue
    const [, entityId, name] = m
    if (entityId === undefined || name === undefined) continue
    // Newer builds report the platform id as `pltfmid=Steam_7656…`; the
    // bare `steamid=` field is still present on both.
    const steamId = field(line, 'steamid') ?? field(line, 'pltfmid')?.replace(/^\w+_/, '')
    const ping = field(line, 'ping')
    const level = field(line, 'level')
    const ip = field(line, 'ip')
    players.push({
      name: name.trim(),
      playerId: entityId,
      userId: steamId ?? entityId,
      ...(ping !== undefined && ping !== '' ? { ping: Number(ping) } : {}),
      ...(level !== undefined && level !== '' ? { level: Number(level) } : {}),
      ...(ip ? { ip } : {}),
    })
  }
  return players
}

// Connect, authenticate, run one command, return everything the server
// said after the command echoed.
export function telnetExec(host: string, port: number, password: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!password) {
      reject(new TelnetError('no telnet password configured'))
      return
    }
    const socket = net.createConnection({ host, port })
    socket.setNoDelay(true)
    socket.setEncoding('utf8')

    let buffer = ''
    let authed = false
    let commandSent = false
    let output = ''
    let done = false
    let idle: NodeJS.Timeout | undefined

    const finish = (err: Error | null, value?: string): void => {
      if (done) return
      done = true
      clearTimeout(overall)
      clearTimeout(connectTimer)
      if (idle) clearTimeout(idle)
      socket.removeAllListeners()
      socket.destroy()
      if (err) reject(err)
      else resolve(value ?? '')
    }

    const connectTimer = setTimeout(
      () => finish(new TelnetError(`telnet connect timed out after ${CONNECT_TIMEOUT_MS}ms`)),
      CONNECT_TIMEOUT_MS,
    )
    // Output that already arrived is the answer; a console that keeps
    // streaming log lines must not cost us the reply we asked for.
    const overall = setTimeout(() => {
      if (commandSent && output !== '') finish(null, output)
      else finish(new TelnetError(`telnet command timed out after ${COMMAND_TIMEOUT_MS}ms`))
    }, COMMAND_TIMEOUT_MS)

    // Restarted on every chunk once the command is out: the reply is
    // whatever arrived by the time the stream goes quiet.
    const bumpIdle = (): void => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => finish(null, output), IDLE_GAP_MS)
    }

    socket.on('error', (err) => finish(new TelnetError(`telnet connection failed: ${err.message}`)))
    socket.on('close', () => {
      if (commandSent) finish(null, output)
      else finish(new TelnetError('telnet connection closed before the command ran'))
    })
    socket.on('connect', () => clearTimeout(connectTimer))

    socket.on('data', (chunk: string) => {
      if (commandSent) {
        output += chunk
        if (output.length > MAX_OUTPUT_BYTES) {
          finish(new TelnetError('telnet response exceeded the size limit'))
          return
        }
        // A known end-of-output marker beats waiting for silence.
        if (TERMINATORS.some((re) => re.test(output))) {
          finish(null, output)
          return
        }
        bumpIdle()
        return
      }
      buffer += chunk
      if (!authed) {
        if (/please enter password:?/i.test(buffer)) {
          socket.write(`${password}\n`)
          buffer = ''
          authed = true
        }
        return
      }
      // The server answers a bad password by saying so and hanging up.
      if (/password incorrect|invalid password/i.test(buffer)) {
        finish(new TelnetError('telnet authentication failed (bad password)'))
        return
      }
      // "Logon successful" is followed by a banner; the prompt marks the
      // console as ready for input.
      if (/logon successful/i.test(buffer)) {
        socket.write(`${command}\n`)
        commandSent = true
        buffer = ''
        bumpIdle()
      }
    })
  })
}

export function create7dtdTelnet(getCreds: () => RconCreds, host = '127.0.0.1'): PlayerAdmin {
  async function exec(command: string): Promise<string> {
    const { port, password } = getCreds()
    if (!port) throw new TelnetError('7 Days to Die has no telnet port configured')
    if (!password) throw new TelnetError('7 Days to Die has no telnet password configured')
    return telnetExec(host, port, password, command)
  }

  return {
    players: async () => parseListPlayers(await exec('lp')),
    announce: async (message) => {
      await exec(`say "${sanitizeMessage(message)}"`)
    },
    kick: async (userId, message) => {
      await exec(`kick ${sanitizeArg(userId)} "${sanitizeMessage(message ?? 'Kicked by an admin')}"`)
    },
    ban: async (userId, message) => {
      await exec(`ban add ${sanitizeArg(userId)} 10 years "${sanitizeMessage(message ?? 'Banned by an admin')}"`)
    },
    unban: async (userId) => {
      await exec(`ban remove ${sanitizeArg(userId)}`)
    },
    save: async () => {
      await exec('saveworld')
    },
  }
}
