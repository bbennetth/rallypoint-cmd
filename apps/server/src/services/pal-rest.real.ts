import { palServerInfoSchema, palServerMetricsSchema, playersResponseSchema } from '@rallypoint-cmd/shared'
import type { Player } from '@rallypoint-cmd/shared'
import type { Logger } from '../logger.js'
import type { GameQuery } from './types.js'
import { readRestCreds } from './rest-creds.js'

const TIMEOUT_MS = 5000

// Client for a Palworld instance's REST API on loopback. Auth = HTTP
// Basic, user `admin`, password = the panel-managed AdminPassword; the
// port is the RESTAPIPort from that instance's ini (default 8212). The
// browser never talks to this — every call is proxied through panel routes.

export function createRealPalRest(logger: Logger, installDir: string): GameQuery {
  function baseUrl(): string {
    const { port } = readRestCreds(installDir)
    return `http://127.0.0.1:${port || 8212}`
  }

  async function call(method: 'GET' | 'POST', apiPath: string, body?: unknown): Promise<unknown> {
    const { password } = readRestCreds(installDir)
    const auth = Buffer.from(`admin:${password}`).toString('base64')
    let res: Response
    try {
      res = await fetch(`${baseUrl()}/v1/api/${apiPath}`, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      throw new Error(
        `Palworld REST API unreachable: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!res.ok) {
      logger.warn('pal rest non-ok', { path: apiPath, status: res.status })
      throw new Error(`Palworld REST API ${apiPath} returned ${res.status}`)
    }
    const text = await res.text()
    if (!text) return {}
    try {
      return JSON.parse(text) as unknown
    } catch {
      return {}
    }
  }

  return {
    reachable: async () => {
      try {
        await call('GET', 'info')
        return true
      } catch {
        return false
      }
    },
    info: async () => palServerInfoSchema.parse(await call('GET', 'info')),
    players: async (): Promise<Player[]> =>
      playersResponseSchema.parse(await call('GET', 'players')).players,
    metrics: async () => palServerMetricsSchema.parse(await call('GET', 'metrics')),
    announce: async (message) => {
      await call('POST', 'announce', { message })
    },
    kick: async (userId, message) => {
      await call('POST', 'kick', { userid: userId, message: message ?? 'Kicked by admin' })
    },
    ban: async (userId, message) => {
      await call('POST', 'ban', { userid: userId, message: message ?? 'Banned by admin' })
    },
    unban: async (userId) => {
      await call('POST', 'unban', { userid: userId })
    },
    save: async () => {
      await call('POST', 'save')
    },
  }
}
