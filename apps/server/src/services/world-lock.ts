// Global mutex over the world's data: backups, restores, steamcmd
// updates, and scheduled restarts all take it so two destructive
// operations can never interleave.

interface Waiter {
  label: string
  resolve: (release: () => void) => void
}

export class WorldLock {
  private holderLabel: string | null = null
  private queue: Waiter[] = []

  get holder(): string | null {
    return this.holderLabel
  }

  // Non-blocking: returns a release fn or null if held. Routes use this
  // to answer 409 instead of queueing user clicks.
  tryAcquire(label: string): (() => void) | null {
    if (this.holderLabel !== null) return null
    this.holderLabel = label
    return this.makeRelease()
  }

  // Blocking: queue until the lock frees. The scheduler uses this so a
  // nightly backup waits for a running update instead of failing.
  acquire(label: string): Promise<() => void> {
    const immediate = this.tryAcquire(label)
    if (immediate) return Promise.resolve(immediate)
    return new Promise((resolve) => {
      this.queue.push({ label, resolve })
    })
  }

  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.queue.shift()
      if (next) {
        this.holderLabel = next.label
        next.resolve(this.makeRelease())
      } else {
        this.holderLabel = null
      }
    }
  }
}

export type AcquireAllResult =
  | { ok: true; release: () => void }
  | { ok: false; busyIndex: number; holder: string | null }

// Take several locks at once, non-blocking: either every lock is held by
// `label` and one release() frees them all, or none is (the ones already
// taken are released before returning) and `busyIndex` says which one was
// busy. Panel-wide ops (panel/wine update) use this over the panel lock
// plus every instance's lock, so a running restore or SteamCMD install
// answers 409 instead of being killed by the panel restart — and
// anything that starts during the update queues behind it.
export function tryAcquireAll(locks: readonly WorldLock[], label: string): AcquireAllResult {
  const releases: (() => void)[] = []
  for (let i = 0; i < locks.length; i++) {
    const lock = locks[i]!
    const release = lock.tryAcquire(label)
    if (!release) {
      const holder = lock.holder
      for (const r of releases.reverse()) r()
      return { ok: false, busyIndex: i, holder }
    }
    releases.push(release)
  }
  return {
    ok: true,
    release: () => {
      for (const r of [...releases].reverse()) r()
    },
  }
}
