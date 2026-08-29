import { describe, expect, it } from 'vitest'
import { GAMES, type GameDef } from './games.js'
import {
  effectiveResources,
  memoryLimitSchema,
  resourcesPatchSchema,
  validateEffectiveResources,
} from './resources.js'

const palworld = GAMES['palworld'] as GameDef

describe('memoryLimitSchema', () => {
  it('accepts a plain number with one binary suffix', () => {
    for (const v of ['8G', '512M', '1.5G', '24K', '2T']) {
      expect(memoryLimitSchema.safeParse(v).success, v).toBe(true)
    }
  })

  it('rejects everything that is not exactly that — the drop-in injection surface', () => {
    for (const v of ['infinity', '80%', '8 G', '8g\n', '1G\n[Service]\nExecStart=/bin/sh', '', 'G', '8GB']) {
      expect(memoryLimitSchema.safeParse(v).success, JSON.stringify(v)).toBe(false)
    }
  })
})

describe('effectiveResources', () => {
  it('overrides win, null falls through to the registry default', () => {
    expect(effectiveResources(palworld, { memoryHigh: '30G', memoryMax: null, cpuQuotaPct: 200 })).toEqual({
      memoryHigh: '30G',
      memoryMax: palworld.memoryMax,
      cpuQuotaPct: 200,
    })
  })

  it('a game without registry caps yields nulls when nothing is overridden', () => {
    expect(effectiveResources(GAMES['rust'] as GameDef, null)).toEqual({
      memoryHigh: null,
      memoryMax: null,
      cpuQuotaPct: null,
    })
  })
})

describe('validateEffectiveResources', () => {
  it('flags a soft limit above the hard limit', () => {
    expect(
      validateEffectiveResources({ memoryHigh: '32G', memoryMax: '16G', cpuQuotaPct: null }),
    ).toMatch(/must not exceed/)
    expect(
      validateEffectiveResources({ memoryHigh: '12G', memoryMax: '16G', cpuQuotaPct: null }),
    ).toBeNull()
    expect(validateEffectiveResources({ memoryHigh: '12G', memoryMax: null, cpuQuotaPct: null })).toBeNull()
  })
})

describe('resourcesPatchSchema', () => {
  it('takes partial patches with explicit null clears and rejects strays', () => {
    expect(resourcesPatchSchema.safeParse({ memoryHigh: '8G' }).success).toBe(true)
    expect(resourcesPatchSchema.safeParse({ cpuQuotaPct: null }).success).toBe(true)
    expect(resourcesPatchSchema.safeParse({ cpuQuotaPct: 99.5 }).success).toBe(false)
    expect(resourcesPatchSchema.safeParse({ nonsense: true }).success).toBe(false)
  })
})
