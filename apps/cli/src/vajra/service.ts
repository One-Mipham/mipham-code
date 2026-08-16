import type { Context } from './context'
import type { Disposer } from './context'

export interface Service {
  inject?: string[]
  /** 声明遵守的宪法原则 id（对齐缝）。挂载前内核校验这些 id 均为已知原则，否则拒绝挂载。 */
  align?: string[]
  apply(ctx: Context): void | Disposer
}

export type ServiceStatus = 'inactive' | 'loading' | 'active' | 'unloading' | 'failed'

export interface Mounted {
  dispose(): void
  status(): ServiceStatus
  readonly error?: Error
}
