// A controllable stand-in for EventSource, which jsdom does not
// implement. Tests drive open/message/error by hand so they can
// reproduce what a real stream does — replay the whole backlog on every
// connect, retry after a drop, or close for good on a 401.

interface Listener {
  (ev: Event): void
}

// Deliberately not `implements EventSource` — the DOM's overloaded
// add/removeEventListener signatures buy nothing here, and the tests only
// ever reach it through the global the hook constructs.
export class FakeEventSource {
  static instances: FakeEventSource[] = []

  static reset(): void {
    FakeEventSource.instances = []
  }

  /** The most recently constructed instance. */
  static get last(): FakeEventSource {
    const es = FakeEventSource.instances.at(-1)
    if (!es) throw new Error('no EventSource was constructed')
    return es
  }

  static install(): void {
    FakeEventSource.reset()
    ;(globalThis as { EventSource?: unknown }).EventSource =
      FakeEventSource as unknown as typeof EventSource
  }

  readonly CONNECTING = 0 as const
  readonly OPEN = 1 as const
  readonly CLOSED = 2 as const

  readyState = 0
  closed = false
  onopen: Listener | null = null
  onerror: Listener | null = null
  private listeners = new Map<string, Set<Listener>>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, fn: Listener): void {
    const set = this.listeners.get(name) ?? new Set<Listener>()
    set.add(fn)
    this.listeners.set(name, set)
  }

  removeEventListener(name: string, fn: Listener): void {
    this.listeners.get(name)?.delete(fn)
  }

  close(): void {
    this.closed = true
    this.readyState = 2
  }

  // --- test drivers ---

  open(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  emit(name: string, data: string): void {
    for (const fn of this.listeners.get(name) ?? []) {
      fn(Object.assign(new Event(name), { data }))
    }
  }

  /** A drop the browser will retry. */
  drop(): void {
    this.readyState = 0
    this.onerror?.(new Event('error'))
  }

  /** A permanent failure — a 401, a 404, a non-event-stream body. */
  fail(): void {
    this.readyState = 2
    this.onerror?.(new Event('error'))
  }
}

// EventSource.CLOSED is read as a static off the global, so the class
// needs the constants too.
Object.assign(FakeEventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 })
