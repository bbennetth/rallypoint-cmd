import { Hono } from 'hono'
import type { ServerLifecycle, ServerStatus } from '@rallypoint-cmd/shared'
import type { HonoApp } from '../context.js'
import { requireSession } from '../middleware/session.js'
import { diskUsage } from '../services/disk.js'
import { resolveWorldId } from '../services/world.js'

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
    try {
      const [info, metrics] = await Promise.all([query.info(), query.metrics()])
      rest = { reachable: true, info, metrics }
    } catch {
      rest = { reachable: false }
    }
  }

  const disks = (
    await Promise.all([diskUsage('game', instance.installDir), diskUsage('backups', env.BACKUP_DIR)])
  ).filter((d): d is NonNullable<typeof d> => d !== null)
  // Collapse duplicates when both dirs share one filesystem.
  const dedupedDisks = disks.filter(
    (d, i) => disks.findIndex((o) => o.totalBytes === d.totalBytes && o.freeBytes === d.freeBytes) === i,
  )

  const status: ServerStatus = {
    lifecycle,
    pendingRestart: settings.getPendingRestart(),
    buildId,
    world: {
      id:
        systemd.installed && instance.game.capabilities.world
          ? resolveWorldId(instance.installDir)
          : null,
    },
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
