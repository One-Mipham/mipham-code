import type { Context, Mounted, Service } from '..'
import type { Bundle, BundleLine, Profile } from './bundle'
import { assemble } from './assemble'

/** 服务解析器：bundle 行的「要挂的代码」——按行解析出要挂载的 Service；纯数据行（如 package-info）返回 undefined 跳过。 */
export type ServiceResolver = (line: BundleLine) => Service | undefined

/** 按行顺序把解析出的 Service 挂进 ctx（依赖未就位则挂起，语义同 ctx.mount）。 */
export function mountLines(
  ctx: Context,
  lines: BundleLine[],
  resolveService: ServiceResolver,
): Mounted[] {
  const mounted: Mounted[] = []
  for (const line of lines) {
    const service = resolveService(line)
    if (service) mounted.push(ctx.mount(service))
  }
  return mounted
}

/** 从 profile 声明式挂载：assemble → mountLines 一整条链。 */
export function mountProfile(
  ctx: Context,
  profile: Profile,
  resolveBundle: (name: string) => Bundle,
  resolveService: ServiceResolver,
): Mounted[] {
  return mountLines(ctx, assemble(profile, resolveBundle), resolveService)
}
