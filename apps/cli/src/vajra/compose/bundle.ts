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
  const data = parseYaml(raw) as { name?: unknown; lines?: unknown }
  if (data.lines !== undefined && !Array.isArray(data.lines)) {
    throw new Error(`bundle "${path}": "lines" must be an array`)
  }
  return {
    name: typeof data.name === 'string' ? data.name : path,
    lines: (data.lines ?? []) as BundleLine[],
  }
}

export function loadProfile(path: string): Profile {
  const raw = readFileSync(path, 'utf-8')
  const data = parseYaml(raw) as { name?: unknown; bundles?: unknown; patch?: unknown }
  if (data.bundles !== undefined && !Array.isArray(data.bundles)) {
    throw new Error(`profile "${path}": "bundles" must be an array`)
  }
  return {
    name: typeof data.name === 'string' ? data.name : path,
    bundles: (data.bundles ?? []) as string[],
    patch: data.patch as Profile['patch'] | undefined,
  }
}
