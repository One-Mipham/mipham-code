import type { Context, Disposer, Constitution } from '../vajra'
import { CONSTITUTION_KEY } from '../vajra'
import { ConstitutionLoader } from './constitution-loader'

/** 默认对齐缝实现：桥接 ConstitutionLoader，校验声明的原则 id 均为已知原则。 */
export function createConstitution(loader: ConstitutionLoader): Constitution {
  return {
    check(aligned) {
      const known = new Set(loader.load().principles.map((p) => p.id))
      return { violations: aligned.filter((id) => !known.has(id)) }
    },
  }
}

/** 把一个 Constitution 挂载为 ctx.constitution（对齐缝）。 */
export function mountConstitution(ctx: Context, constitution: Constitution): Disposer {
  return ctx.provide(CONSTITUTION_KEY, constitution)
}
