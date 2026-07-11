import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PluginManifest {
  name: string
  version: string
  miphamVersion?: string
  hooks?: Record<string, unknown>
}

export function validatePlugin(dir: string): {
  valid: boolean
  errors: string[]
  manifest?: PluginManifest
} {
  const errors: string[] = []

  try {
    const raw = readFileSync(join(dir, 'plugin.json'), 'utf-8')
    const manifest = JSON.parse(raw) as PluginManifest

    if (!manifest.name || !/^[a-z0-9-]+$/.test(manifest.name)) {
      errors.push('Invalid plugin name: must be lowercase alphanumeric with hyphens')
    }
    if (!manifest.version) {
      errors.push('Missing required field: version')
    }

    // Check for suspicious hooks
    if (manifest.hooks) {
      const hooksStr = JSON.stringify(manifest.hooks)
      if (hooksStr.includes('rm -rf') || hooksStr.includes('curl') || hooksStr.includes('eval')) {
        errors.push('Suspicious hook commands detected — manual review required')
      }
    }

    return { valid: errors.length === 0, errors, manifest }
  } catch (err) {
    return { valid: false, errors: [`Failed to read plugin.json: ${String(err)}`] }
  }
}
