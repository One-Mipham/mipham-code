import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface PluginManifest {
  name: string
  version?: string
  miphamVersion?: string
  hooks?: Record<string, unknown>
  /** Claude manifest fields (commands/agents/skills/mcpServers/…) — read by the Claude loader. */
  [key: string]: unknown
}

/** Which manifest convention a plugin uses. */
export type PluginFormat = 'mipham' | 'claude'

export interface PluginValidation {
  valid: boolean
  errors: string[]
  manifest?: PluginManifest
  format: PluginFormat
  /** Resolved manifest path (empty when no manifest found). */
  manifestPath: string
}

/**
 * Resolve a plugin's manifest. Mipham plugins use `plugin.json` at the plugin
 * root; Claude marketplace plugins use `.claude-plugin/plugin.json`.
 */
function resolveManifestPath(dir: string): { path: string; format: PluginFormat } | null {
  const mipham = join(dir, 'plugin.json')
  if (existsSync(mipham)) return { path: mipham, format: 'mipham' }
  const claude = join(dir, '.claude-plugin', 'plugin.json')
  if (existsSync(claude)) return { path: claude, format: 'claude' }
  return null
}

/** Detect a plugin's manifest convention (defaults to Mipham when absent). */
export function detectPluginFormat(dir: string): PluginFormat {
  return resolveManifestPath(dir)?.format ?? 'mipham'
}

export function validatePlugin(dir: string): PluginValidation {
  const resolved = resolveManifestPath(dir)
  if (!resolved) {
    return {
      valid: false,
      errors: ['No plugin manifest found (expected plugin.json or .claude-plugin/plugin.json)'],
      format: 'mipham',
      manifestPath: '',
    }
  }

  const errors: string[] = []
  try {
    const raw = readFileSync(resolved.path, 'utf-8')
    const manifest = JSON.parse(raw) as PluginManifest

    if (!manifest.name || !/^[a-z0-9-]+$/.test(manifest.name)) {
      errors.push('Invalid plugin name: must be lowercase alphanumeric with hyphens')
    }
    // Mipham plugins require a version; Claude plugins only require `name`.
    if (resolved.format === 'mipham' && !manifest.version) {
      errors.push('Missing required field: version')
    }
    if (manifest.hooks) {
      const hooksStr = JSON.stringify(manifest.hooks)
      if (hooksStr.includes('rm -rf') || hooksStr.includes('curl') || hooksStr.includes('eval')) {
        errors.push('Suspicious hook commands detected — manual review required')
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      manifest,
      format: resolved.format,
      manifestPath: resolved.path,
    }
  } catch (err) {
    const label = resolved.format === 'claude' ? '.claude-plugin/plugin.json' : 'plugin.json'
    return {
      valid: false,
      errors: [`Failed to read ${label}: ${String(err)}`],
      format: resolved.format,
      manifestPath: resolved.path,
    }
  }
}
