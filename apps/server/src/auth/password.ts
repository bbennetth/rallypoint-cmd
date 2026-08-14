import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { scryptAsync } from '@noble/hashes/scrypt.js'

// Password hashing — peppered scrypt, ported from rallypoint-core
// id-api (apps/id-api/src/crypto/password.ts). `key_version` lets the
// pepper rotate without a flag day: each hash row records which pepper
// version was applied.
//
// scrypt via the audited pure-JS @noble/hashes keeps the panel free of a
// second native module (better-sqlite3 is already one). Params are
// stored per hash so they can be raised later.
const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_DKLEN = 32
const SALT_BYTES = 16

// Security floor for params read back from a stored hash (OWASP scrypt
// minimums) — stops a tampered secretHash from downgrading the cost.
const MIN_N = 16384
const MIN_R = 8
const MIN_P = 1

export interface PasswordHasher {
  readonly currentKeyVersion: number
  hash(password: string): Promise<{ secretHash: string; keyVersion: number }>
  verify(secretHash: string, keyVersion: number, password: string): Promise<boolean>
  // Constant-time dummy hash invoked when the user-lookup misses, to
  // equalize login timing.
  dummyVerify(): Promise<void>
}

export interface PasswordHasherConfig {
  pepper: string
  pepperVersion?: number
  legacyPeppers?: Record<number, string>
}

// Stored as `scrypt$<N>$<r>$<p>$<base64 salt>$<base64 dk>`.
function encodeHash(salt: Uint8Array, dk: Uint8Array): string {
  const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${b64(salt)}$${b64(dk)}`
}

interface ParsedHash {
  N: number
  r: number
  p: number
  salt: Buffer
  dk: Buffer
}

function parseHash(secretHash: string): ParsedHash | null {
  const parts = secretHash.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null
  if (N < MIN_N || r < MIN_R || p < MIN_P) return null
  const salt = Buffer.from(parts[4]!, 'base64')
  const dk = Buffer.from(parts[5]!, 'base64')
  if (salt.length === 0 || dk.length === 0) return null
  return { N, r, p, salt, dk }
}

async function derive(
  peppered: string,
  salt: Uint8Array,
  opts: { N: number; r: number; p: number; dkLen: number },
): Promise<Buffer> {
  return Buffer.from(await scryptAsync(peppered, salt, opts))
}

// Module-level dummy-hash cache keyed by (version, pepper) so the ~32 MiB
// derivation happens at most once per pair per process.
const dummyHashCache = new Map<string, Promise<string>>()

export function createPasswordHasher(config: PasswordHasherConfig): PasswordHasher {
  const currentKeyVersion = config.pepperVersion ?? 1
  const peppers: Record<number, string> = {
    [currentKeyVersion]: config.pepper,
    ...config.legacyPeppers,
  }

  function pepper(password: string, version: number): string {
    const key = peppers[version]
    if (!key) throw new Error(`Unknown PANEL_PASSWORD_PEPPER key_version ${version}`)
    return createHmac('sha256', key).update(password, 'utf8').digest('hex')
  }

  function ensureDummyHash(): Promise<string> {
    const cacheKey = `${currentKeyVersion}:${peppers[currentKeyVersion]}`
    let cached = dummyHashCache.get(cacheKey)
    if (!cached) {
      cached = (async () => {
        const peppered = pepper('rallypoint-dummy-password-not-a-real-secret', currentKeyVersion)
        const salt = randomBytes(SALT_BYTES)
        const dk = await derive(peppered, salt, {
          N: SCRYPT_N,
          r: SCRYPT_R,
          p: SCRYPT_P,
          dkLen: SCRYPT_DKLEN,
        })
        return encodeHash(salt, dk)
      })()
      dummyHashCache.set(cacheKey, cached)
    }
    return cached
  }

  return {
    currentKeyVersion,
    async hash(password) {
      const peppered = pepper(password, currentKeyVersion)
      const salt = randomBytes(SALT_BYTES)
      const dk = await derive(peppered, salt, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        dkLen: SCRYPT_DKLEN,
      })
      return { secretHash: encodeHash(salt, dk), keyVersion: currentKeyVersion }
    },
    async verify(secretHash, keyVersion, password) {
      const parsed = parseHash(secretHash)
      if (!parsed) return false
      try {
        const peppered = pepper(password, keyVersion)
        const dk2 = await derive(peppered, parsed.salt, {
          N: parsed.N,
          r: parsed.r,
          p: parsed.p,
          dkLen: parsed.dk.length,
        })
        return parsed.dk.length === dk2.length && timingSafeEqual(parsed.dk, dk2)
      } catch {
        return false
      }
    },
    async dummyVerify() {
      const h = await ensureDummyHash()
      const parsed = parseHash(h)
      if (!parsed) return
      try {
        const peppered = pepper('definitely-not-the-password', currentKeyVersion)
        const dk2 = await derive(peppered, parsed.salt, {
          N: parsed.N,
          r: parsed.r,
          p: parsed.p,
          dkLen: parsed.dk.length,
        })
        // The point is the timing, not the outcome.
        if (parsed.dk.length === dk2.length) timingSafeEqual(parsed.dk, dk2)
      } catch {
        // swallow
      }
    },
  }
}
