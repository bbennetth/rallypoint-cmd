import type { MiddlewareHandler } from 'hono'
import type { GameDef } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { ApiError } from '../errors.js'

// Capability gate: 404s a whole feature area for games whose registry
// entry lacks it (e.g. mods on Valheim). The web UI hides the pages too;
// this is the API-side enforcement.
export function requireCapability(
  pred: (game: GameDef) => boolean,
  what: string,
): MiddlewareHandler<HonoApp> {
  return async (c, next) => {
    const { game } = c.get('services').instance
    if (!pred(game)) {
      throw new ApiError({
        code: 'capability_unsupported',
        message: `${game.name} does not support ${what}.`,
        status: 404,
      })
    }
    await next()
  }
}
