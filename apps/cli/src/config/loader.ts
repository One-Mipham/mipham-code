import {
  readFileSync,
  existsSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  chmodSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import type { MiphamConfig, ProviderConfig, McpServerConfig } from '../shared/index.ts'
import { DEFAULT_CONFIG } from './defaults'

const MIPHAM_HOME = join(homedir(), '.mipham')
const BACKUP_PREFIX = 'config.backup-'

/**
 * Parse a YAML config file safely. Returns null on any error (missing file, bad syntax, etc).
 * Prints a warning to stderr so the user knows something is wrong.
 */
function safeParseYaml(path: string, label: string): Partial<MiphamConfig> | null {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf-8')
    return parseYaml(raw) as Partial<MiphamConfig>
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`⚠ Mipham Code: failed to parse ${label} (${path}): ${msg}\n`)
    return null
  }
}

/**
 * Deep-merge providers: for each provider in the user config, only override
 * the fields the user explicitly set (apiKey, baseUrl). All other fields
 * (name, protocol, models, status) come from the base defaults.
 *
 * This prevents users from accidentally losing model definitions when they
 * only want to set their API key.
 */
function mergeProviders(
  baseProviders: ProviderConfig[],
  overrideProviders: ProviderConfig[],
): ProviderConfig[] {
  const merged = [...baseProviders]

  for (const op of overrideProviders) {
    const idx = merged.findIndex((bp) => bp.id === op.id)
    if (idx === -1) {
      // Provider not in defaults — add it wholesale (custom provider)
      merged.push(op)
      continue
    }

    // Merge: user overrides only the fields they provide
    const base = merged[idx]!
    merged[idx] = {
      id: base.id,
      name: op.name || base.name,
      protocol: op.protocol || base.protocol,
      baseUrl: op.baseUrl ?? base.baseUrl,
      apiKey: op.apiKey ?? base.apiKey,
      models: op.models?.length ? op.models : base.models,
      status: op.status ?? base.status,
    }
  }

  return merged
}

function mergeConfig(base: MiphamConfig, override: Partial<MiphamConfig>): MiphamConfig {
  const merged: MiphamConfig = { ...base, ...override }
  if (override.providers) {
    merged.providers = mergeProviders(base.providers, override.providers)
  } else {
    merged.providers = base.providers
  }
  return merged
}

/**
 * Save a timestamped backup of config.yml to ~/.mipham/.
 * Keeps at most 5 backups; older ones are pruned.
 */
function backupConfig(configPath: string): void {
  try {
    if (!existsSync(configPath)) return
    mkdirSync(MIPHAM_HOME, { recursive: true, mode: 0o700 })

    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = join(MIPHAM_HOME, `${BACKUP_PREFIX}${ts}.yml`)
    copyFileSync(configPath, backupPath)
    chmodSync(backupPath, 0o600) // owner read/write only — contains API keys

    // Prune old backups (keep last 5)
    const files = readdirSync(MIPHAM_HOME)
      .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith('.yml'))
      .sort()
    while (files.length > 5) {
      const old = files.shift()!
      try {
        unlinkSync(join(MIPHAM_HOME, old))
      } catch {
        // best-effort cleanup
      }
    }
  } catch {
    // best-effort; never crash because backup failed
  }
}

/**
 * Try to restore config from the most recent backup.
 * Returns true if restored successfully.
 */
function tryRestoreFromBackup(configPath: string): boolean {
  try {
    if (!existsSync(MIPHAM_HOME)) return false
    const files = readdirSync(MIPHAM_HOME)
      .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith('.yml'))
      .sort()
      .reverse() // newest first

    if (files.length === 0) return false

    const latestBackup = join(MIPHAM_HOME, files[0]!)
    copyFileSync(latestBackup, configPath)
    process.stderr.write(`⚠ Mipham Code: restored config from backup (${files[0]})\n`)
    return true
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`⚠ Mipham Code: failed to restore config from backup: ${msg}\n`)
    return false
  }
}

/**
 * Load MCP servers from a .mcp.json file (Claude Code convention).
 *
 * Format:
 *   { "mcpServers": { "name": { "command": "...", "args": [...], "env": {...} } } }
 *
 * Scans both project-level (.mipham/mcp.json) and user-level (~/.mipham/mcp.json).
 * Config.yml entries take precedence over .mcp.json entries with the same name.
 */
function loadMcpJson(cwd: string): McpServerConfig[] {
  const servers: McpServerConfig[] = []
  const searchPaths = [
    join(cwd, '.mipham', 'mcp.json'),
    join(cwd, '.mcp.json'),
    join(MIPHAM_HOME, 'mcp.json'),
  ]

  for (const path of searchPaths) {
    try {
      if (!existsSync(path)) continue
      const raw = readFileSync(path, 'utf-8')
      const parsed = JSON.parse(raw) as {
        mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>
      }

      if (parsed.mcpServers) {
        for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
          // Avoid duplicates by name
          if (servers.some((s) => s.name === name)) continue
          servers.push({
            name,
            command: cfg.command,
            args: cfg.args || [],
            env: cfg.env,
          })
        }
      }
    } catch {
      // Silently skip malformed or missing .mcp.json files
    }
  }

  return servers
}

export function loadConfig(cwd: string = process.cwd()): MiphamConfig {
  const configPath = join(cwd, '.mipham', 'config.yml')
  const userConfigPath = join(MIPHAM_HOME, 'config.yml')

  let config = { ...DEFAULT_CONFIG }

  // ── Load project-level config ──
  const projectConfig = safeParseYaml(configPath, 'project config')
  if (projectConfig) {
    config = mergeConfig(config, projectConfig)
  } else if (existsSync(configPath)) {
    // File exists but failed to parse — try to restore from backup
    process.stderr.write(`⚠ Mipham Code: project config is corrupted, attempting recovery...\n`)
    if (!tryRestoreFromBackup(configPath)) {
      process.stderr.write(`⚠ Mipham Code: no backup available for project config. Skipping.\n`)
    } else {
      // Retry parsing after restore
      const restored = safeParseYaml(configPath, 'restored project config')
      if (restored) {
        config = mergeConfig(config, restored)
      }
    }
  }

  // ── Load user-level config ──
  const userConfig = safeParseYaml(userConfigPath, 'user config')
  if (userConfig) {
    config = mergeConfig(config, userConfig)
  } else if (existsSync(userConfigPath)) {
    // File exists but failed to parse — try to restore from backup
    process.stderr.write(`⚠ Mipham Code: user config is corrupted, attempting recovery...\n`)
    if (!tryRestoreFromBackup(userConfigPath)) {
      process.stderr.write(`⚠ Mipham Code: no backup available for user config. Skipping.\n`)
    } else {
      // Retry parsing after restore
      const restored = safeParseYaml(userConfigPath, 'restored user config')
      if (restored) {
        config = mergeConfig(config, restored)
      }
    }
  } else {
    // No user config yet — create the directory so it's ready
    try {
      mkdirSync(MIPHAM_HOME, { recursive: true })
    } catch {
      // best-effort
    }
  }

  // ── Load .mcp.json servers (project + user level) ──
  const mcpJsonServers = loadMcpJson(cwd)
  if (mcpJsonServers.length > 0) {
    const existingServers = config.skills?.mcpServers ?? []
    // Merge: config.yml servers take precedence by name
    const existingNames = new Set(existingServers.map((s) => s.name))
    const newFromJson = mcpJsonServers.filter((s) => !existingNames.has(s.name))
    config = {
      ...config,
      skills: {
        paths: config.skills?.paths ?? [],
        mcpServers: [...existingServers, ...newFromJson],
      },
    }
  }

  // ── Auto-backup: save a copy of the user config if it loaded successfully ──
  if (userConfig) {
    backupConfig(userConfigPath)
  }

  return config
}
