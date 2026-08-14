import type { EventsOfMode } from './events'
import type { Service, Mounted, ServiceStatus } from './service'

export type Disposer = () => void

type Listener = (...args: any[]) => any

export class Context {
  private services = new Map<string, unknown>()
  private effects: Disposer[] = []
  private listeners = new Map<string, Listener[]>()
  private waiters: Array<() => boolean> = []
  readonly parent?: Context

  constructor(parent?: Context) {
    this.parent = parent
  }

  provide<T>(key: string, value: T): Disposer {
    this.services.set(key, value)
    this.flushWaiters()
    return () => {
      this.services.delete(key)
    }
  }

  private flushWaiters(): void {
    this.waiters = this.waiters.filter((w) => !w())
  }

  mount(service: Service): Mounted {
    const keys = service.inject ?? []
    let status: ServiceStatus = 'inactive'
    let error: Error | undefined
    let disposer: Disposer = () => {}
    let applied = false
    let disposed = false
    let effectSnapshot = -1

    const tryApply = (): boolean => {
      if (applied) return true
      if (!keys.every((k) => this.has(k))) return false
      applied = true
      status = 'loading'
      effectSnapshot = this.effects.length
      try {
        disposer = service.apply(this) ?? (() => {})
        status = 'active'
      } catch (e) {
        error = e as Error
        status = 'failed'
      }
      return true
    }

    const waiter = (): boolean => {
      if (disposed) {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        return true
      }
      if (!tryApply()) return false
      this.waiters = this.waiters.filter((w) => w !== waiter)
      return true
    }

    if (!tryApply()) {
      this.waiters.push(waiter)
    }

    const mounted: Mounted = {
      dispose: () => {
        disposed = true
        this.waiters = this.waiters.filter((w) => w !== waiter)
        if (status === 'active') {
          status = 'unloading'
          disposer()
        }
        if (effectSnapshot >= 0) {
          while (this.effects.length > effectSnapshot) {
            this.effects.pop()!()
          }
        }
      },
      status: () => status,
    }
    Object.defineProperty(mounted, 'error', { get: () => error })
    return mounted
  }

  get<T>(key: string): T | undefined {
    return (this.services.get(key) as T | undefined) ?? this.parent?.get<T>(key)
  }

  has(key: string): boolean {
    return this.services.has(key) || (this.parent?.has(key) ?? false)
  }

  scope(_key: unknown): Context {
    return new Context(this)
  }

  effect(fn: () => Disposer | void): Disposer {
    const d = fn() ?? (() => {})
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      d()
    }
    this.effects.push(dispose)
    return dispose
  }

  on(event: string, fn: Listener): Disposer {
    const ls = this.listeners.get(event) ?? []
    ls.push(fn)
    this.listeners.set(event, ls)
    return () => {
      const cur = this.listeners.get(event)
      if (cur)
        this.listeners.set(
          event,
          cur.filter((l) => l !== fn),
        )
    }
  }

  emit(event: EventsOfMode<'emit'>, ...args: unknown[]): void {
    for (const fn of this.listeners.get(event) ?? []) fn(...args)
  }

  async waterfall<T>(event: EventsOfMode<'waterfall'>, value: T, ...args: unknown[]): Promise<T> {
    const ls = this.listeners.get(event) ?? []
    const run = async (i: number, v: T): Promise<T> => {
      if (i >= ls.length) return v
      const next = async (nextVal?: T) => run(i + 1, nextVal === undefined ? v : nextVal)
      return (await ls[i]!(v, ...args, next)) as T
    }
    return run(0, value)
  }

  async parallel(event: EventsOfMode<'parallel'>, ...args: unknown[]): Promise<unknown[]> {
    return Promise.all((this.listeners.get(event) ?? []).map((fn) => fn(...args)))
  }

  async serial(event: EventsOfMode<'serial'>, ...args: unknown[]): Promise<unknown[]> {
    const out: unknown[] = []
    for (const fn of this.listeners.get(event) ?? []) out.push(await fn(...args))
    return out
  }

  dispose(): void {
    const errors: unknown[] = []
    while (this.effects.length) {
      try {
        this.effects.pop()!()
      } catch (e) {
        errors.push(e)
      }
    }
    this.services.clear()
    this.listeners.clear()
    if (errors.length) throw new AggregateError(errors)
  }
}
