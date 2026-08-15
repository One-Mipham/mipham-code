import type { Profile, Bundle, BundleLine } from './bundle'

export function assemble(profile: Profile, resolveBundle: (name: string) => Bundle): BundleLine[] {
  return profile.bundles.flatMap((name) => resolveBundle(name).lines)
}
