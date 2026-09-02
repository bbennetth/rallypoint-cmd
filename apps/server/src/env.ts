import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

// Release artifacts ship a release.json at the repo root ({version,
// commit, builtAt}); when present it is the authoritative panel version.
// Dev/git checkouts have none and fall back to the npm package version
// with a -dev suffix (compared as its base version by the update check).
function readReleaseVersion(): string | null {
  for (const p of [path.resolve('release.json'), path.resolve('../../release.json')]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string }
      if (typeof parsed.version === 'string' && parsed.version) return parsed.version
    } catch {
      // missing/unreadable — keep looking
    }
  }
  return null
}

// Typed environment. Parsed once at boot (server.ts) and injected via
// context — handlers never read process.env directly.

const boolFromString = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1')

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // `live` drives the real LXC (systemctl/steamcmd/REST); `mock` swaps in
  // fake services over a temp-dir sandbox so the whole panel runs on a
  // laptop with no game server.
  PANEL_MODE: z.enum(['live', 'mock']).default('live'),
  PANEL_HOST: z.string().default('127.0.0.1'),
  PANEL_PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  // Filesystem layout (live defaults match the LXC provisioner).
  DATA_DIR: z.string().optional(),
  PANEL_BACKUP_DIR: z.string().optional(),
  // Parent dir for game-server installs — each server lives at
  // GAMES_ROOT/<slug>.
  GAMES_ROOT: z.string().optional(),
  STEAMCMD_BIN: z.string().optional(),
  // When set, the panel serves the built React SPA from here (production).
  // Unset in dev — Vite serves the SPA and proxies /api to this server.
  WEB_DIST_DIR: z.string().optional(),

  // Secrets. Required in production; dev/test fall back to fixed values.
  PANEL_PASSWORD_PEPPER: z.string().min(16).optional(),
  PANEL_PEPPER_VERSION: z.coerce.number().int().min(1).default(1),

  // First-boot admin seed (used only when the admins table is empty).
  // The provisioner sets these; dev falls back to admin / a generated
  // password printed once to the log.
  PANEL_ADMIN_USERNAME: z.string().min(1).max(64).default('admin'),
  PANEL_ADMIN_PASSWORD: z.string().min(8).max(256).optional(),

  SESSION_TTL_DAYS: z.coerce.number().min(1).max(365).default(30),
  // Behind an HTTPS reverse proxy set COOKIE_SECURE=true → the session
  // cookie gets the __Host- prefix + Secure. Plain-http LAN access needs
  // it false or login silently fails.
  COOKIE_SECURE: boolFromString,
  // When true (behind a trusted reverse proxy) trust the forwarded client
  // IP for rate-limit keying — the LAST X-Forwarded-For entry (the hop the
  // proxy appended), or CF-Connecting-IP; otherwise use the socket
  // address. Only safe when every request really passes through a proxy
  // that appends the connecting address.
  TRUSTED_PROXY: boolFromString,

  // Free-space floor for backups/uploads/steamcmd (bytes).
  DISK_FLOOR_BYTES: z.coerce.number().int().nonnegative().default(5 * 1024 ** 3),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(2 * 1024 ** 3),
  MAX_UNCOMPRESSED_BYTES: z.coerce.number().int().positive().default(8 * 1024 ** 3),
})

export interface Env {
  NODE_ENV: 'development' | 'test' | 'production'
  PANEL_MODE: 'live' | 'mock'
  PANEL_HOST: string
  PANEL_PORT: number
  DATA_DIR: string
  PANEL_BACKUP_DIR: string
  GAMES_ROOT: string
  STEAMCMD_BIN: string
  WEB_DIST_DIR: string | undefined
  DB_PATH: string
  PANEL_PASSWORD_PEPPER: string
  PANEL_PEPPER_VERSION: number
  PANEL_ADMIN_USERNAME: string
  PANEL_ADMIN_PASSWORD: string | undefined
  SESSION_TTL_DAYS: number
  COOKIE_SECURE: boolean
  SESSION_COOKIE_NAME: string
  CSRF_COOKIE_NAME: string
  TRUSTED_PROXY: boolean
  DISK_FLOOR_BYTES: number
  MAX_UPLOAD_BYTES: number
  MAX_UNCOMPRESSED_BYTES: number
  PANEL_VERSION: string
}

const DEV_PEPPER = 'dev-pepper-not-a-secret-0123456789abcdef'

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.parse(raw)

  const isProd = parsed.NODE_ENV === 'production'
  if (isProd && !parsed.PANEL_PASSWORD_PEPPER) {
    throw new Error('PANEL_PASSWORD_PEPPER is required in production')
  }

  // Mock mode sandboxes all filesystem paths under ./data so a laptop
  // run never touches /opt or /var.
  const mock = parsed.PANEL_MODE === 'mock'
  const sandboxRoot = path.resolve(process.cwd(), 'data')
  const dataDir = parsed.DATA_DIR ?? (mock ? path.join(sandboxRoot, 'panel') : '/var/lib/rallypoint-cmd')
  const backupDir =
    parsed.PANEL_BACKUP_DIR ?? (mock ? path.join(sandboxRoot, 'backups') : '/var/backups/rallypoint-cmd')
  const gamesRoot = parsed.GAMES_ROOT ?? (mock ? path.join(sandboxRoot, 'games') : '/opt/games')
  // SteamCMD is shared by every game, so it lives at the game-neutral
  // /opt/steamcmd. Existing deploys pin STEAMCMD_BIN in panel.env; the
  // provisioner's update path migrates them to this location.
  const steamcmdBin =
    parsed.STEAMCMD_BIN ?? (mock ? path.join(sandboxRoot, 'steamcmd.sh') : '/opt/steamcmd/steamcmd.sh')

  const cookieSecure = parsed.COOKIE_SECURE
  return {
    ...parsed,
    DATA_DIR: dataDir,
    PANEL_BACKUP_DIR: backupDir,
    GAMES_ROOT: gamesRoot,
    STEAMCMD_BIN: steamcmdBin,
    DB_PATH: path.join(dataDir, 'panel.sqlite'),
    WEB_DIST_DIR: parsed.WEB_DIST_DIR,
    PANEL_PASSWORD_PEPPER: parsed.PANEL_PASSWORD_PEPPER ?? DEV_PEPPER,
    PANEL_ADMIN_PASSWORD: parsed.PANEL_ADMIN_PASSWORD,
    COOKIE_SECURE: cookieSecure,
    // __Host- requires Secure + Path=/ + no Domain; only usable behind TLS.
    SESSION_COOKIE_NAME: cookieSecure ? '__Host-rp_session' : 'rp_session',
    CSRF_COOKIE_NAME: cookieSecure ? '__Host-rp_csrf' : 'rp_csrf',
    TRUSTED_PROXY: parsed.TRUSTED_PROXY,
    PANEL_VERSION: readReleaseVersion() ?? `${raw.npm_package_version ?? '0.1.0'}-dev`,
  }
}
