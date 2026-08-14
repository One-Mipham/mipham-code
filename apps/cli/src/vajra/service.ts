import type { Context } from './context'
import type { Disposer } from './context'

export interface Service {
  inject?: string[]
  apply(ctx: Context): void | Disposer
}

export type ServiceStatus = 'inactive' | 'loading' | 'active' | 'unloading' | 'failed'

export interface Mounted {
  dispose(): void
  status(): ServiceStatus
  readonly error?: Error
}
