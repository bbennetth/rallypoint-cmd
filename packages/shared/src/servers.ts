import { z } from 'zod'
import { serverLifecycleSchema } from './server-status.js'
import { GAME_SLUGS } from './games.js'

// Multi-server contract: the panel manages a list of game-server
// instances, each tied to one registry game. Route param `:serverId`
// scopes every game-facing API call to one instance.

export const serverIdSchema = z.string().regex(/^[a-z0-9-]{1,32}$/)

export const gameServerSchema = z.object({
  id: serverIdSchema,
  gameSlug: z.enum(GAME_SLUGS),
  name: z.string().min(1).max(64),
  unitName: z.string(),
  createdAtMs: z.number().int().nonnegative(),
})
export type GameServer = z.infer<typeof gameServerSchema>

// List entry: the server row plus a cheap status summary (no REST probe
// — the dashboard cards only need lifecycle + memory).
export const gameServerSummarySchema = gameServerSchema.extend({
  lifecycle: serverLifecycleSchema,
  memoryCurrentBytes: z.number().int().nonnegative().nullable(),
  buildId: z.string().nullable(),
})
export type GameServerSummary = z.infer<typeof gameServerSummarySchema>

export const serversResponseSchema = z.object({
  servers: z.array(gameServerSummarySchema),
})
export type ServersResponse = z.infer<typeof serversResponseSchema>

export const createServerRequestSchema = z.object({
  gameSlug: z.enum(GAME_SLUGS),
  name: z.string().min(1).max(64),
})
export type CreateServerRequest = z.infer<typeof createServerRequestSchema>
