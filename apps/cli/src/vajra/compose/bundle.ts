import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

export type BundleLine = {
  id: string
  kind: 'tool' | 'provider' | 'skill' | 'service'
  config: Record<string, unknown>
}
export type Bundle = { name: string; lines: BundleLine[] }
export type Profile = {
  name: string
  bundles: string[]
  patch?: Record<string, Partial<BundleLine>>
}

export function loadBundle(path: string): Bundle {
  const raw = readFileSync(path, 'utf-8')
  const data = parseYaml(raw) as { name?: string; lines?: BundleLine[] }
  return { name: data.name ?? path, lines: data.lines ?? [] }
}

export function loadProfile(path: string): Profile {
  const raw = readFileSync(path, 'utf-8')
  const data = parseYaml(raw) as Profile
  return { name: data.name ?? path, bundles: data.bundles ?? [], patch: data.patch }
}
