import { z } from 'zod'
import { parseSystemdBytes } from './metrics.js'
import type { GameDef } from './games.js'

// Per-server resource overrides, editable from the panel. Effective
// value = override ?? registry default (games.ts memoryHigh/memoryMax);
// null means "use the default". CPU quota has no registry default.
//
// These strings end up verbatim in a systemd drop-in under /etc, so the
// schemas are deliberately narrow: a plain number with one binary
// suffix, nothing else. No `infinity`, no percentages, no whitespace —
// keeping the write surface tiny is what rules out drop-in injection.

export const memoryLimitSchema = z
  .string()
  .regex(/^\d+(\.\d+)?[KMGT]$/, 'Use a number with a K/M/G/T suffix, e.g. "8G" or "512M".')

// systemd CPUQuota percent of ONE core: 100 = one full core, 200 = two.
// Upper bound is a sanity cap; the route clamps to the real host cores.
export const cpuQuotaPctSchema = z.number().int().min(10).max(6400)

export const resourceOverridesSchema = z.object({
  memoryHigh: memoryLimitSchema.nullable(),
  memoryMax: memoryLimitSchema.nullable(),
  cpuQuotaPct: cpuQuotaPctSchema.nullable(),
})
export type ResourceOverrides = z.infer<typeof resourceOverridesSchema>

// PUT body: only the present keys change; explicit null clears an
// override back to the game default.
export const resourcesPatchSchema = z
  .object({
    memoryHigh: memoryLimitSchema.nullable().optional(),
    memoryMax: memoryLimitSchema.nullable().optional(),
    cpuQuotaPct: cpuQuotaPctSchema.nullable().optional(),
  })
  .strict()
export type ResourcesPatch = z.infer<typeof resourcesPatchSchema>

export const effectiveResourcesSchema = z.object({
  memoryHigh: z.string().nullable(),
  memoryMax: z.string().nullable(),
  cpuQuotaPct: z.number().int().nullable(),
})
export type EffectiveResources = z.infer<typeof effectiveResourcesSchema>

export const resourcesResponseSchema = z.object({
  overrides: resourceOverridesSchema,
  defaults: effectiveResourcesSchema,
  effective: effectiveResourcesSchema,
  host: z.object({
    cpus: z.number().int().positive(),
    memBytes: z.number().int().nonnegative(),
  }),
  pendingRestart: z.boolean(),
})
export type ResourcesResponse = z.infer<typeof resourcesResponseSchema>

export const resourcesUpdateResponseSchema = z.object({
  ok: z.literal(true),
  pendingRestart: z.literal(true),
})

export function effectiveResources(
  game: Pick<GameDef, 'memoryHigh' | 'memoryMax'>,
  overrides?: Partial<ResourceOverrides> | null,
): EffectiveResources {
  return {
    memoryHigh: overrides?.memoryHigh ?? game.memoryHigh ?? null,
    memoryMax: overrides?.memoryMax ?? game.memoryMax ?? null,
    cpuQuotaPct: overrides?.cpuQuotaPct ?? null,
  }
}

// Cross-field sanity for the *effective* pair: MemoryHigh above
// MemoryMax would make the soft limit dead letter. Returns an error
// message, or null when fine.
export function validateEffectiveResources(effective: EffectiveResources): string | null {
  const high = parseSystemdBytes(effective.memoryHigh ?? undefined)
  const max = parseSystemdBytes(effective.memoryMax ?? undefined)
  if (high !== null && max !== null && high > max) {
    return `MemoryHigh (${effective.memoryHigh}) must not exceed MemoryMax (${effective.memoryMax}).`
  }
  return null
}
