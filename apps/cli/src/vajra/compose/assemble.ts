import type { Profile, Bundle, BundleLine } from './bundle'

export function assemble(profile: Profile, resolveBundle: (name: string) => Bundle): BundleLine[] {
  // 浅拷贝每行，使 patch 不回写共享的 bundle 行对象（不同 profile 共享同一 bundle 时补丁隔离）
  const lines = profile.bundles.flatMap((name) =>
    resolveBundle(name).lines.map((l) => ({ ...l, config: { ...l.config } })),
  )
  if (profile.patch) {
    for (const [id, partial] of Object.entries(profile.patch)) {
      const target = lines.find((l) => l.id === id)
      if (target) {
        Object.assign(target, partial)
      } else {
        lines.push({ id, kind: partial.kind ?? 'tool', config: partial.config ?? {} })
      }
    }
  }
  return lines
}
