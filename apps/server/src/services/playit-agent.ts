import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { SYSTEMCTL_BIN, JOURNALCTL_BIN } from './constants.js'

const execFileAsync = promisify(execFile)

// The playit.gg agent, driven directly (the panel runs as root inside the
// unprivileged LXC). Everything here is scoped to the agent the apt
// package installs: its unit, its secret file, its journal.
//
// The packaged systemd unit runs playitd with a fixed secret path
// (`ExecStart=... --secret-path /etc/playit/playit.toml`). `playit
// secret-path` cannot be used to discover it: since the daemon split it
// answers over the playitd socket, which needs the service already
// running.
export const PLAYIT_SECRET_FILE = '/etc/playit/playit.toml'

const APT_KEY_URL = 'https://playit-cloud.github.io/ppa/key.gpg'
const APT_KEYRING = '/etc/apt/trusted.gpg.d/playit.gpg'
const APT_SOURCES = '/etc/apt/sources.list.d/playit-cloud.list'

const CLAIM_CODE_RE = /^[a-z0-9]{4,64}$/
const SECRET_RE = /^[A-Za-z0-9]{32,128}$/

export interface PlayitStatus {
  installed: boolean
  claimed: boolean
  running: boolean
}

// PATH lookup without a shell — the apt package lands in /usr/bin, but
// honour PATH the way `command -v` did.
export function playitBinPath(): string | null {
  const dirs = (process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin').split(':')
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = path.join(dir, 'playit')
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // not here — keep looking
    }
  }
  return null
}

// Packaging has varied (playit.service vs playitd.service), so detect
// rather than hardcode.
export async function detectUnitName(): Promise<string> {
  for (const u of ['playit', 'playitd']) {
    try {
      const { stdout } = await execFileAsync(
        SYSTEMCTL_BIN,
        ['list-unit-files', `${u}.service`, '--no-legend'],
        { timeout: 10_000 },
      )
      if (stdout.trim()) return `${u}.service`
    } catch {
      // list-unit-files exits non-zero when nothing matches
    }
  }
  return 'playit.service'
}

// Parse the secret out of the toml (strip key syntax + quotes). Exported
// for testing.
export function parseSecret(toml: string): string | null {
  for (const line of toml.split('\n')) {
    const m = line.match(/secret_key\s*=\s*"?([A-Za-z0-9]+)"?\s*$/)
    if (m?.[1]) return m[1]
  }
  return null
}

export function readSecret(): string | null {
  try {
    return parseSecret(fs.readFileSync(PLAYIT_SECRET_FILE, 'utf8'))
  } catch {
    return null
  }
}

export async function status(): Promise<PlayitStatus> {
  const installed = playitBinPath() !== null
  const claimed = readSecret() !== null
  let running = false
  if (installed) {
    try {
      const { stdout } = await execFileAsync(SYSTEMCTL_BIN, ['is-active', await detectUnitName()], {
        timeout: 10_000,
      })
      running = stdout.trim() === 'active'
    } catch {
      // is-active exits non-zero for every inactive state
    }
  }
  return { installed, claimed, running }
}

export async function install(): Promise<void> {
  if (playitBinPath()) return

  const res = await fetch(APT_KEY_URL, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`playit apt key fetch failed: HTTP ${res.status}`)
  const key = Buffer.from(await res.arrayBuffer())

  await new Promise<void>((resolve, reject) => {
    const gpg = spawn('gpg', ['--batch', '--yes', '--dearmor', '-o', APT_KEYRING], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    gpg.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    gpg.on('error', reject)
    gpg.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`gpg --dearmor exited ${code}: ${stderr.trim()}`)),
    )
    gpg.stdin.end(key)
  })

  fs.writeFileSync(
    APT_SOURCES,
    `deb [signed-by=${APT_KEYRING}] https://playit-cloud.github.io/ppa/data ./\n`,
  )

  const aptEnv = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }
  await execFileAsync('apt-get', ['-qq', 'update'], { timeout: 300_000, env: aptEnv })
  await execFileAsync('apt-get', ['-qq', '-y', 'install', 'playit'], {
    timeout: 300_000,
    env: aptEnv,
  })

  // The package enables its unit on install; keep it down until claimed.
  const unit = await detectUnitName()
  await execFileAsync(SYSTEMCTL_BIN, ['disable', '--now', unit], { timeout: 30_000 }).catch(
    () => undefined,
  )
}

export async function generateClaimCode(): Promise<string> {
  const bin = playitBinPath()
  if (!bin) throw new Error('playit is not installed')
  const { stdout } = await execFileAsync(bin, ['claim', 'generate'], { timeout: 30_000 })
  const code = stdout.trim().split(/\s+/).pop() ?? ''
  if (!CLAIM_CODE_RE.test(code)) throw new Error(`Unexpected claim code: ${code}`)
  return code
}

// Blocks until the user approves the claim in their browser (or it times
// out). `claim exchange` only PRINTS the secret (progress lines first,
// secret on the last line) — persisting it where playitd reads it is on
// us; only the interactive `playit setup` flow does that itself.
export async function claim(code: string): Promise<void> {
  if (!CLAIM_CODE_RE.test(code)) throw new Error('invalid claim code')
  const bin = playitBinPath()
  if (!bin) throw new Error('playit is not installed')

  const { stdout } = await execFileAsync(bin, ['claim', 'exchange', code, '--wait', '300'], {
    timeout: 330_000,
  })
  const secret = (stdout.trim().split('\n').pop() ?? '').replace(/\s/g, '')
  if (!SECRET_RE.test(secret)) throw new Error('claim exchange did not return a secret')

  fs.mkdirSync(path.dirname(PLAYIT_SECRET_FILE), { recursive: true, mode: 0o750 })
  fs.writeFileSync(PLAYIT_SECRET_FILE, `secret_key = "${secret}"\n`, { mode: 0o600 })
  fs.chmodSync(PLAYIT_SECRET_FILE, 0o600)
  // The package ships its own `playit` user that the daemon drops to; the
  // secret has to be readable by it.
  await execFileAsync('chown', ['playit:playit', PLAYIT_SECRET_FILE], { timeout: 10_000 }).catch(
    () => undefined,
  )

  const unit = await detectUnitName()
  await execFileAsync(SYSTEMCTL_BIN, ['enable', unit], { timeout: 30_000 })
  // restart, not `enable --now`: a daemon left running without a secret
  // (WaitingForSecret) won't re-read the file on its own.
  await execFileAsync(SYSTEMCTL_BIN, ['restart', unit], { timeout: 60_000 })
}

export async function start(): Promise<void> {
  await execFileAsync(SYSTEMCTL_BIN, ['enable', '--now', await detectUnitName()], {
    timeout: 60_000,
  })
}

export async function stop(): Promise<void> {
  await execFileAsync(SYSTEMCTL_BIN, ['disable', '--now', await detectUnitName()], {
    timeout: 60_000,
  })
}

// `playit reset` needs the daemon socket, which we're about to stop —
// removing the secret file directly is equivalent for the packaged unit.
export async function reset(): Promise<void> {
  await execFileAsync(SYSTEMCTL_BIN, ['disable', '--now', await detectUnitName()], {
    timeout: 60_000,
  }).catch(() => undefined)
  fs.rmSync(PLAYIT_SECRET_FILE, { force: true })
}

export async function logs(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      JOURNALCTL_BIN,
      ['-u', await detectUnitName(), '-n', '200', '--no-pager', '-o', 'short-iso'],
      { timeout: 30_000 },
    )
    return stdout.split('\n').filter((l) => l.trim())
  } catch {
    return ['(no agent journal)']
  }
}
