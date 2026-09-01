import { Hono } from 'hono'
import type { ServerLifecycle, ServerStatus } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { requireSession } from '../middleware/session.js'
import { dedupeDisks, diskUsage } from '../services/disk.js'
import { contractFor } from '../services/backup-contracts.js'
import { newestSaveMtimeMs } from '../services/world.js'

export const statusRoutes = new Hono<HonoApp>()

function toLifecycle(installed: boolean, activeState: string): ServerLifecycle {
  if (!installed) return 'not_installed'
  switch (activeState) {
    case 'active':
      return 'active'
    case 'activating':
      return 'activating'
    case 'deactivating':
      return 'deactivating'
    case 'failed':
      return 'failed'
    default:
      return 'inactive'
  }
}

statusRoutes.get('/status', requireSession, async (c) => {
  const env = c.get('env')
  const { instance, gameControl, query, steamcmd, settings } = c.get('services')

  const [systemd, buildId] = await Promise.all([gameControl.status(), steamcmd.installedBuildId()])

  const lifecycle = toLifecycle(systemd.installed, systemd.activeState)

  // The admin API is only worth probing while the unit is up — and only
  // for games that have one.
  let rest: ServerStatus['rest'] = { reachable: false }
  if (lifecycle === 'active' && instance.game.capabilities.query !== 'none') {
    // Settled, not all: a query that can only answer half the probe
    // (Satisfactory's LWQ has no player counts) still contributes what
    // it has instead of collapsing the whole block to unreachable.
    const [info, metrics] = await Promise.allSettled([query.info(), query.metrics()])
    if (info.status === 'fulfilled' || metrics.status === 'fulfilled') {
      rest = {
        reachable: true,
        ...(info.status === 'fulfilled' ? { info: info.value } : {}),
        ...(metrics.status === 'fulfilled' ? { metrics: metrics.value } : {}),
      }
    }
  }

  // World identity + last-save time from the live save dir (newest file
  // mtime, skipping the game's internal-backup dirs).
  function worldStatus(): ServerStatus['world'] {
    if (!systemd.installed || !instance.game.capabilities.world) return { id: null, lastSavedAtMs: null }
    const contract = contractFor(instance.game)
    const live = contract.resolveLive(instance.installDir)
    if (!live) return { id: null, lastSavedAtMs: null }
    return {
      id: live.worldId,
      lastSavedAtMs: newestSaveMtimeMs(live.saveDir, contract.internalBackupDirs),
    }
  }

  const dedupedDisks = dedupeDisks(
    (
      await Promise.all([diskUsage('game', instance.installDir), diskUsage('backups', env.PANEL_BACKUP_DIR)])
    ).filter((d): d is NonNullable<typeof d> => d !== null),
  )

  const status: ServerStatus = {
    lifecycle,
    pendingRestart: settings.getPendingRestart(),
    buildId,
    world: worldStatus(),
    systemd: {
      activeState: systemd.activeState,
      subState: systemd.subState,
      memoryCurrentBytes: systemd.memoryCurrentBytes,
      activeEnterAtMs: systemd.activeEnterAtMs,
    },
    rest,
    disks: dedupedDisks,
  }
  return c.json(status)
})
