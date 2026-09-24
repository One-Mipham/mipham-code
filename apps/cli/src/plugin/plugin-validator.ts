import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { toMcpServerConfig } from './claude-plugin'

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
  /**
   * Findings that do not block installation.
   *
   * The split is the point: a declaration we would silently drop is a defect in one
   * part of one plugin, and refusing to install the whole thing over it would make
   * the validator an obstacle rather than a report. What it must not do is stay
   * quiet — a dropped declaration that nothing mentions is indistinguishable from
   * one that worked.
   */
  warnings: string[]
  manifest?: PluginManifest
  format: PluginFormat
  /** Resolved manifest path (empty when no manifest found). */
  manifestPath: string
}

/**
 * Whether `loadPlugins` will hand this declaration to the MCP client.
 *
 * Lives here so the check and the loader read one rule: `plugin-loader.ts` calls
 * this at its guard, and the MCP checks below call it to decide what to report. It
 * requires a `name` because that is the key the client connects under, and one
 * transport or the other — `McpServerConfig` makes `command` and `url` mutually
 * exclusive, so demanding a `command` is what used to drop every remote server.
 */
export function isLoadableMcpConfig(cfg: {
  name?: unknown
  command?: unknown
  url?: unknown
}): boolean {
  return (
    typeof cfg.name === 'string' &&
    cfg.name.length > 0 &&
    (typeof cfg.command === 'string' || typeof cfg.url === 'string')
  )
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

/**
 * `${user_config.*}` is Claude Code's placeholder for a value it prompts the user
 * for at install time. This loader has no such step: `expandPluginRoot` substitutes
 * `${CLAUDE_PLUGIN_ROOT}` and nothing else, so the reference reaches the server as
 * literal text. Every reference is reported — "declared" and "undeclared" are not a
 * useful split here, because neither one resolves.
 */
const USER_CONFIG_RE = /\$\{user_config\.([A-Za-z0-9_.-]+)\}/g

function userConfigKeys(texts: string[]): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const text of texts) {
    for (const m of text.matchAll(USER_CONFIG_RE)) {
      const key = m[1]!
      if (seen.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
  }
  return keys
}

/** Hosts for which a cleartext URL stays on the machine, so there is nothing in transit. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function cleartextWarning(server: string, url: string): string | null {
  if (!/^http:\/\//i.test(url)) return null
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return null // an unparseable URL is not the finding this check is for
  }
  if (LOOPBACK_HOSTS.has(host)) return null
  return `MCP server "${server}" uses a cleartext http:// URL (${url}) — it is readable in transit`
}

const DROPPED = 'declares neither command nor url and would be skipped at load'

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Check the Claude-format sources: `.mcp.json` at the root, plus inline `mcpServers`. */
function checkClaudeMcp(
  dir: string,
  manifest: PluginManifest,
  texts: string[],
  warnings: string[],
): void {
  const inspect = (label: string, servers: unknown): void => {
    if (!servers || typeof servers !== 'object') return
    for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
      const raw = (entry ?? {}) as Record<string, unknown>
      if (toMcpServerConfig(name, raw) === null) {
        warnings.push(`${label}: MCP server "${name}" ${DROPPED}`)
        continue
      }
      if (typeof raw.url === 'string') {
        const cleartext = cleartextWarning(name, raw.url)
        if (cleartext) warnings.push(`${label}: ${cleartext}`)
      }
    }
  }

  const mcpJsonPath = join(dir, '.mcp.json')
  if (existsSync(mcpJsonPath)) {
    const text = readFileSync(mcpJsonPath, 'utf-8')
    texts.push(text)
    try {
      inspect('`.mcp.json`', (JSON.parse(text) as { mcpServers?: unknown }).mcpServers)
    } catch (err) {
      warnings.push(`\`.mcp.json\` could not be parsed and is skipped at load: ${describe(err)}`)
    }
  }

  const inline = manifest.mcpServers
  if (typeof inline === 'string') {
    // The manifest type admits a string here, and the loader's `collect` returns
    // early on anything that is not an object — so this form is declared and read
    // by nothing.
    warnings.push('`mcpServers` is a string; this loader only reads an object and ignores it')
  } else {
    inspect('manifest `mcpServers`', inline)
  }
}

/** Check the Mipham-format source: `mcp-servers/*.json` at the plugin root. */
function checkMiphamMcp(dir: string, texts: string[], warnings: string[]): void {
  const mcpDir = join(dir, 'mcp-servers')
  if (!existsSync(mcpDir)) return

  let entries: string[]
  try {
    entries = readdirSync(mcpDir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const label = `\`mcp-servers/${entry}\``
    let text: string
    try {
      text = readFileSync(join(mcpDir, entry), 'utf-8')
    } catch (err) {
      warnings.push(`${label} could not be read and is skipped at load: ${describe(err)}`)
      continue
    }
    texts.push(text)

    let cfg: Record<string, unknown>
    try {
      cfg = JSON.parse(text) as Record<string, unknown>
    } catch (err) {
      warnings.push(`${label} could not be parsed and is skipped at load: ${describe(err)}`)
      continue
    }

    if (!isLoadableMcpConfig(cfg ?? {})) {
      warnings.push(`${label}: MCP server "${String(cfg?.name ?? entry)}" ${DROPPED}`)
      continue
    }
    if (typeof cfg.url === 'string') {
      const cleartext = cleartextWarning(String(cfg.name), cfg.url)
      if (cleartext) warnings.push(`${label}: ${cleartext}`)
    }
  }
}

export function validatePlugin(dir: string): PluginValidation {
  const resolved = resolveManifestPath(dir)
  if (!resolved) {
    return {
      valid: false,
      errors: ['No plugin manifest found (expected plugin.json or .claude-plugin/plugin.json)'],
      warnings: [],
      format: 'mipham',
      manifestPath: '',
    }
  }

  const errors: string[] = []
  try {
    const raw = readFileSync(resolved.path, 'utf-8').replace(/^\uFEFF/, '')
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

    const warnings: string[] = []
    // Every text read on the way to a declaration, so a `${user_config.*}` inside an
    // `args` array or a header value is caught wherever it appears.
    const texts: string[] = [raw]
    if (resolved.format === 'claude') {
      checkClaudeMcp(dir, manifest, texts, warnings)
    } else {
      checkMiphamMcp(dir, texts, warnings)
    }
    for (const key of userConfigKeys(texts)) {
      warnings.push(
        `\`\${user_config.${key}}\` is passed through literally — this loader has no user-config ` +
          `step, so the server receives the text itself`,
      )
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      manifest,
      format: resolved.format,
      manifestPath: resolved.path,
    }
  } catch (err) {
    const label = resolved.format === 'claude' ? '.claude-plugin/plugin.json' : 'plugin.json'
    return {
      valid: false,
      errors: [`Failed to read ${label}: ${String(err)}`],
      warnings: [],
      format: resolved.format,
      manifestPath: resolved.path,
    }
  }
}
