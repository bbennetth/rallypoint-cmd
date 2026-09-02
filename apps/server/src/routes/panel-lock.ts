import { errors } from '../errors.js'
import type { ComposedServices } from '../services/compose.js'
import { tryAcquireAll } from '../services/world-lock.js'

// Panel-wide exclusive section for ops that disturb every server at once
// (panel self-update restarts the process; the Wine upgrade swaps the
// loader): hold the panel lock and every instance's world lock, or 409
// naming whoever is busy. The returned release() frees all of them and
// is idempotent, so the usual `try { longOps.start(..., finally release())
// } catch { release() }` shape works unchanged.
export function acquirePanelWide(composed: ComposedServices, label: string): () => void {
  const instances = composed.instances.list()
  const result = tryAcquireAll([composed.worldLock, ...instances.map((i) => i.worldLock)], label)
  if (result.ok) return result.release
  const who = result.busyIndex === 0 ? 'The panel' : (instances[result.busyIndex - 1]?.name ?? 'A server')
  throw errors.conflict(
    'world_busy',
    `${who} is busy (${result.holder ?? 'unknown'}) — wait for that operation to finish first.`,
  )
}
