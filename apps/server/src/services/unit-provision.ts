import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Logger } from '../logger.js'
import { GAME_HELPER_BIN, assertAllowedSlug, type GameHelperVerb } from './constants.js'

const execFileAsync = promisify(execFile)

// Provisions/deprovisions the systemd side of a game unit (start.sh +
// instance.conf drop-in) via the pinned root helper. Argv is fixed per
// (verb, slug) pair in sudoers — no user-controlled strings reach root.

export interface UnitProvisioner {
  provision(slug: string): Promise<void>
  deprovision(slug: string): Promise<void>
}

export function createRealUnitProvisioner(logger: Logger): UnitProvisioner {
  async function run(verb: GameHelperVerb, slug: string): Promise<void> {
    assertAllowedSlug(slug)
    try {
      await execFileAsync('sudo', ['-n', GAME_HELPER_BIN, verb, slug], { timeout: 60_000 })
      logger.info('unit provisioner ok', { verb, slug })
    } catch (err) {
      const stderr =
        err !== null && typeof err === 'object' && 'stderr' in err ? String(err.stderr).trim() : ''
      const msg = stderr || (err instanceof Error ? err.message : String(err))
      logger.error('unit provisioner failed', { verb, slug, err: msg })
      throw new Error(`rallypoint-cmd-game ${verb} ${slug} failed: ${msg}`)
    }
  }
  return {
    provision: (slug) => run('add', slug),
    deprovision: (slug) => run('remove', slug),
  }
}

export function createFakeUnitProvisioner(logger: Logger): UnitProvisioner {
  async function run(verb: GameHelperVerb, slug: string): Promise<void> {
    assertAllowedSlug(slug)
    logger.info('fake unit provisioner', { verb, slug })
  }
  return {
    provision: (slug) => run('add', slug),
    deprovision: (slug) => run('remove', slug),
  }
}
