import type { Profile, Bundle, BundleLine } from './bundle'

export function assemble(
  profile: Profile,
  resolveBundle: (name: string) => Bundle,
): BundleLine[] {
  const lines = profile.bundles.flatMap((name) => resolveBundle(name).lines)
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
