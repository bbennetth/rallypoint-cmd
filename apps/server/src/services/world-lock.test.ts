import { describe, expect, it } from 'vitest'
import { tryAcquireAll, WorldLock } from './world-lock.js'

describe('tryAcquireAll', () => {
  it('takes every lock and one release frees them all', () => {
    const locks = [new WorldLock(), new WorldLock(), new WorldLock()]
    const r = tryAcquireAll(locks, 'panel_update')
    expect(r.ok).toBe(true)
    for (const l of locks) expect(l.holder).toBe('panel_update')
    if (r.ok) r.release()
    for (const l of locks) expect(l.holder).toBeNull()
  })

  it('releases what it took when a later lock is busy, and names it', () => {
    const locks = [new WorldLock(), new WorldLock(), new WorldLock()]
    const held = locks[1]!.tryAcquire('restore')
    expect(held).not.toBeNull()

    const r = tryAcquireAll(locks, 'panel_update')
    expect(r).toEqual({ ok: false, busyIndex: 1, holder: 'restore' })
    expect(locks[0]!.holder).toBeNull() // taken, then given back
    expect(locks[1]!.holder).toBe('restore') // untouched
    expect(locks[2]!.holder).toBeNull() // never reached
  })

  it('lets a queued acquire() proceed once the composite release runs', async () => {
    const locks = [new WorldLock(), new WorldLock()]
    const r = tryAcquireAll(locks, 'wine_update')
    expect(r.ok).toBe(true)
    let got = false
    const pending = locks[1]!.acquire('schedule:backup').then((release) => {
      got = true
      release()
    })
    await Promise.resolve()
    expect(got).toBe(false) // still queued behind the panel op
    if (r.ok) {
      r.release()
      r.release() // idempotent
    }
    await pending
    expect(got).toBe(true)
    expect(locks[1]!.holder).toBeNull()
  })

  it('succeeds trivially on an empty list', () => {
    const r = tryAcquireAll([], 'x')
    expect(r.ok).toBe(true)
  })
})
