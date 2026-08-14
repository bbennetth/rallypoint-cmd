import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import type { Logger } from '../logger.js'
import type { Journal } from './types.js'
import { JOURNALCTL_BIN, assertAllowedUnit, journalctlTailArgs } from './constants.js'

const BUFFER_MAX = 500
const RESPAWN_DELAY_MS = 3000

// Per-unit journald tailer: ONE `sudo journalctl -f` per game server no
// matter how many SSE viewers are connected. Subscribers replay the ring
// buffer, then get live lines. The child is respawned with backoff if it
// dies and killed on panel shutdown.

export function createRealJournal(logger: Logger, unitName: string): Journal {
  assertAllowedUnit(unitName)
  const emitter = new EventEmitter()
  emitter.setMaxListeners(100)
  const buffer: string[] = []
  let child: ChildProcessByStdio<null, Readable, null> | null = null
  let stopped = true
  let respawnTimer: ReturnType<typeof setTimeout> | null = null

  function push(line: string): void {
    buffer.push(line)
    if (buffer.length > BUFFER_MAX) buffer.shift()
    emitter.emit('line', line)
  }

  // Guarded reschedule — a failed spawn emits BOTH 'error' and 'exit', so
  // without the `respawnTimer || child` guard we'd start two tailers.
  function scheduleRespawn(reason: string): void {
    if (stopped || respawnTimer || child) return
    logger.warn('journalctl tailer down; respawning', { reason })
    respawnTimer = setTimeout(() => {
      respawnTimer = null
      spawnTailer()
    }, RESPAWN_DELAY_MS)
  }

  function spawnTailer(): void {
    if (stopped || child) return
    // Frozen argv — must match deploy/sudoers/rallypoint-cmd exactly.
    child = spawn('sudo', ['-n', JOURNALCTL_BIN, ...journalctlTailArgs(unitName)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const rl = createInterface({ input: child.stdout })
    rl.on('line', push)
    child.on('exit', (code) => {
      child = null
      rl.close()
      scheduleRespawn(`exit ${code}`)
    })
    // Spawn failure (bad sudoers, missing binary): recover instead of
    // wedging the tailer forever with a non-null `child`.
    child.on('error', (err) => {
      logger.error('journalctl spawn error', { err: err.message })
      child = null
      rl.close()
      scheduleRespawn('spawn error')
    })
  }

  return {
    buffer: () => buffer,
    subscribe: (cb) => {
      emitter.on('line', cb)
      return () => emitter.off('line', cb)
    },
    start: () => {
      if (!stopped) return
      stopped = false
      spawnTailer()
    },
    stop: () => {
      stopped = true
      if (respawnTimer) clearTimeout(respawnTimer)
      respawnTimer = null
      child?.kill('SIGTERM')
      child = null
    },
  }
}
