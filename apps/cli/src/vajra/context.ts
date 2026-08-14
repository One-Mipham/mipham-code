export type Disposer = () => void

export class Context {
  private services = new Map<string, unknown>()
  private effects: Disposer[] = []
  readonly parent?: Context

  constructor(parent?: Context) {
    this.parent = parent
  }

  provide<T>(key: string, value: T): Disposer {
    this.services.set(key, value)
    return () => {
      this.services.delete(key)
    }
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

  dispose(): void {
    while (this.effects.length) this.effects.pop()!()
    this.services.clear()
  }
}
