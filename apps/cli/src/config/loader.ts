import {
  readFileSync,
  existsSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  chmodSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type {
  MiphamConfig,
  ProviderConfig,
  McpServerConfig,
  InferenceHookConfig,
  CredentialMaskingConfig,
  BackgroundAgentConfig,
  CrossSessionConfig,
} from '../shared/index.ts'
import {
  DEFAULT_CONFIG,
  DEFAULT_INFERENCE_HOOK_CONFIG,
  DEFAULT_CREDENTIAL_MASKING_CONFIG,
  DEFAULT_BACKGROUND_AGENT_CONFIG,
  DEFAULT_CROSS_SESSION_CONFIG,
} from './defaults'
import { getCredentialKey, encryptApiKey, decryptApiKey, ENC_PREFIX } from './credential-crypto'

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
  allowBaseUrlOverride: boolean,
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
      // baseUrl is a routing field — it decides where the user's API key is
      // sent, so only trusted (user-level) config may override it. Untrusted
      // (project-level) config cannot redirect a built-in provider's traffic.
      baseUrl: allowBaseUrlOverride ? (op.baseUrl ?? base.baseUrl) : base.baseUrl,
      apiKey: op.apiKey ?? base.apiKey,
      models: op.models?.length ? op.models : base.models,
      status: op.status ?? base.status,
    }
  }

  return merged
}

function mergeConfig(
  base: MiphamConfig,
  override: Partial<MiphamConfig>,
  allowBaseUrlOverride: boolean,
): MiphamConfig {
  const merged: MiphamConfig = { ...base, ...override }
  if (override.providers) {
    merged.providers = mergeProviders(base.providers, override.providers, allowBaseUrlOverride)
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
        mcpServers?: Record<
          string,
          {
            command?: string
            args?: string[]
            url?: string
            headers?: Record<string, string>
            env?: Record<string, string>
          }
        >
      }

      if (parsed.mcpServers) {
        for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
          // Avoid duplicates by name
          if (servers.some((s) => s.name === name)) continue
          servers.push({
            name,
            command: cfg.command,
            args: cfg.args || [],
            url: cfg.url,
            headers: cfg.headers,
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
    config = mergeConfig(config, projectConfig, false)
  } else if (existsSync(configPath)) {
    // File exists but failed to parse — try to restore from backup
    process.stderr.write(`⚠ Mipham Code: project config is corrupted, attempting recovery...\n`)
    if (!tryRestoreFromBackup(configPath)) {
      process.stderr.write(`⚠ Mipham Code: no backup available for project config. Skipping.\n`)
    } else {
      // Retry parsing after restore
      const restored = safeParseYaml(configPath, 'restored project config')
      if (restored) {
        config = mergeConfig(config, restored, false)
      }
    }
  }

  // ── Load user-level config ──
  const userConfig = safeParseYaml(userConfigPath, 'user config')
  if (userConfig) {
    config = mergeConfig(config, userConfig, true)
  } else if (existsSync(userConfigPath)) {
    // File exists but failed to parse — try to restore from backup
    process.stderr.write(`⚠ Mipham Code: user config is corrupted, attempting recovery...\n`)
    if (!tryRestoreFromBackup(userConfigPath)) {
      process.stderr.write(`⚠ Mipham Code: no backup available for user config. Skipping.\n`)
    } else {
      // Retry parsing after restore
      const restored = safeParseYaml(userConfigPath, 'restored user config')
      if (restored) {
        config = mergeConfig(config, restored, true)
      }
    }
  } else {
    // No user config on disk — try to recover from a backup (e.g. the file was
    // deleted). If no backup exists either, this is a first run: just create the
    // directory so it's ready.
    if (!tryRestoreFromBackup(userConfigPath)) {
      try {
        mkdirSync(MIPHAM_HOME, { recursive: true })
      } catch {
        // best-effort
      }
    } else {
      const restored = safeParseYaml(userConfigPath, 'restored user config')
      if (restored) {
        config = mergeConfig(config, restored, true)
      }
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

  // ── Decrypt API keys at rest (enc:v1:) back to plaintext ──
  decryptProviderApiKeys(config.providers)

  return config
}

/**
 * Load inference hooks (DLP) configuration from the same config sources
 * as the main config. Merges project-level over user-level.
 *
 * Returns default (disabled) config if no inference_hooks section is present.
 */
export function loadInferenceHookConfig(): InferenceHookConfig {
  // DLP is a user/org-level security setting — the endpoint controls where the
  // entire conversation is sent, so a project config must NOT be able to
  // redirect it (exfiltration). Read only from the user-level config.
  const userConfigPath = join(MIPHAM_HOME, 'config.yml')

  let merged = { ...DEFAULT_INFERENCE_HOOK_CONFIG }

  const paths = [userConfigPath]
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue
      const raw = readFileSync(path, 'utf-8')
      const parsed = parseYaml(raw) as Record<string, unknown>
      const section = parsed.inference_hooks as Partial<InferenceHookConfig> | undefined
      if (section) {
        merged = {
          endpoint: section.endpoint ?? merged.endpoint,
          signing_secret: section.signing_secret ?? merged.signing_secret,
          timeout: section.timeout ?? merged.timeout,
          on_failure: section.on_failure ?? merged.on_failure,
          organization_id: section.organization_id ?? merged.organization_id,
          headers: { ...merged.headers, ...(section.headers || {}) },
        }
      }
    } catch {
      // Silently skip malformed configs — main loadConfig already warns
    }
  }

  return merged
}

/**
 * Load credential masking configuration from the same config sources.
 * Merges project-level over user-level. Returns defaults if no section present.
 */
export function loadCredentialMaskingConfig(cwd: string = process.cwd()): CredentialMaskingConfig {
  const configPath = join(cwd, '.mipham', 'config.yml')
  const userConfigPath = join(MIPHAM_HOME, 'config.yml')

  let merged = { ...DEFAULT_CREDENTIAL_MASKING_CONFIG }

  const paths = [userConfigPath, configPath] // project wins (loaded last)
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue
      const raw = readFileSync(path, 'utf-8')
      const parsed = parseYaml(raw) as Record<string, unknown>
      const section = parsed.credential_masking as Partial<CredentialMaskingConfig> | undefined
      if (section) {
        merged = {
          enabled: section.enabled ?? merged.enabled,
          files: section.files ?? merged.files,
          output_scrubbing: {
            enabled: section.output_scrubbing?.enabled ?? merged.output_scrubbing.enabled,
            patterns: section.output_scrubbing?.patterns ?? merged.output_scrubbing.patterns,
          },
          env_filter: {
            enabled: section.env_filter?.enabled ?? merged.env_filter.enabled,
            patterns: section.env_filter?.patterns ?? merged.env_filter.patterns,
          },
        }
      }
    } catch {
      // Silently skip malformed configs
    }
  }

  return merged
}

/**
 * Load background agent configuration from config sources.
 */
export function loadBackgroundAgentConfig(cwd: string = process.cwd()): BackgroundAgentConfig {
  const configPath = join(cwd, '.mipham', 'config.yml')
  const userConfigPath = join(MIPHAM_HOME, 'config.yml')

  let merged = { ...DEFAULT_BACKGROUND_AGENT_CONFIG }

  const paths = [userConfigPath, configPath]
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue
      const raw = readFileSync(path, 'utf-8')
      const parsed = parseYaml(raw) as Record<string, unknown>
      const section = parsed.background_agent as Partial<BackgroundAgentConfig> | undefined
      if (section) {
        merged = {
          auto_commit: section.auto_commit ?? merged.auto_commit,
          auto_push: section.auto_push ?? merged.auto_push,
          auto_worktree: section.auto_worktree ?? merged.auto_worktree,
          commit_coauthors: section.commit_coauthors ?? merged.commit_coauthors,
        }
      }
    } catch {
      // Silently skip malformed configs
    }
  }

  return merged
}

/**
 * Load cross-session messaging configuration from the same config sources.
 * Merges project-level over user-level. Returns defaults if no section present.
 */
export function loadCrossSessionConfig(cwd: string = process.cwd()): CrossSessionConfig {
  const configPath = join(cwd, '.mipham', 'config.yml')
  const userConfigPath = join(MIPHAM_HOME, 'config.yml')

  let merged = { ...DEFAULT_CROSS_SESSION_CONFIG }

  const paths = [userConfigPath, configPath] // project wins (loaded last)
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue
      const raw = readFileSync(path, 'utf-8')
      const parsed = parseYaml(raw) as Record<string, unknown>
      const section = parsed.cross_session as Partial<CrossSessionConfig> | undefined
      if (section) {
        merged = {
          crossSessionInbound: section.crossSessionInbound ?? merged.crossSessionInbound,
          dialogExpiry: section.dialogExpiry ?? merged.dialogExpiry,
        }
      }
    } catch {
      // Silently skip malformed configs
    }
  }

  return merged
}

/**
 * Decrypt any encrypted (`enc:v1:`) provider API keys in place, after config
 * merge. Plaintext (legacy / env-template) values pass through untouched. On
 * decrypt failure (missing/corrupt credential key) the key is cleared and a
 * warning is written, so the provider surfaces "apiKey not set" rather than
 * sending a garbage value.
 */
function decryptProviderApiKeys(providers: ProviderConfig[] | undefined): void {
  if (!providers) return
  const needsKey = providers.some((p) => p.apiKey.startsWith(ENC_PREFIX))
  if (!needsKey) return
  const key = getCredentialKey(MIPHAM_HOME)
  for (const p of providers) {
    if (!p.apiKey.startsWith(ENC_PREFIX)) continue
    try {
      p.apiKey = decryptApiKey(p.apiKey, key)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `⚠ Mipham Code: failed to decrypt API key for "${p.id}" (credential key missing/corrupt?): ${msg}\n`,
      )
      p.apiKey = ''
    }
  }
}

/**
 * Read a single provider's API key from config.yml, decrypting it if stored
 * encrypted. Returns null when the provider has no key or the key can't be
 * decrypted. Used by `/keys view` to show the plaintext key on request.
 */
export function getProviderApiKey(providerId: string, cwd: string = process.cwd()): string | null {
  const userConfigPath = join(MIPHAM_HOME, 'config.yml')
  const projectConfigPath = join(cwd, '.mipham', 'config.yml')
  const configPath = existsSync(userConfigPath) ? userConfigPath : projectConfigPath

  try {
    if (!existsSync(configPath)) return null
    const raw = readFileSync(configPath, 'utf-8')
    const doc = (parseYaml(raw) as Record<string, unknown>) || {}
    const providers = (doc.providers as Array<Record<string, unknown>>) || []
    const p = providers.find((x) => x.id === providerId)
    if (!p || typeof p.apiKey !== 'string') return null
    if (!p.apiKey.startsWith(ENC_PREFIX)) return p.apiKey
    return decryptApiKey(p.apiKey, getCredentialKey(MIPHAM_HOME))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`⚠ Mipham Code: failed to read API key for "${providerId}": ${msg}\n`)
    return null
  }
}

/**
 * Persist an API key for a single provider to the user-level config.yml.
 * Reads the existing YAML, updates/replaces the provider's apiKey field,
 * and writes it back. Creates the config if it doesn't exist.
 *
 * Returns true on success, false on failure.
 */
export function saveProviderApiKey(providerId: string, apiKey: string): boolean {
  // API keys are user-level secrets — always persist to the user config, never
  // the project config (which lives in the repo and could be committed).
  const configPath = join(MIPHAM_HOME, 'config.yml')

  try {
    mkdirSync(MIPHAM_HOME, { recursive: true, mode: 0o700 })

    // Read existing config (or start fresh)
    let doc: Record<string, unknown> = {}
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8')
      doc = (parseYaml(raw) as Record<string, unknown>) || {}
    }

    // Find and update the provider in the providers array
    const providers = (doc.providers as Array<Record<string, unknown>>) || []
    const idx = providers.findIndex((p) => p.id === providerId)

    // Encrypt literal keys at rest (env-variable templates pass through).
    const storedKey = encryptApiKey(apiKey, getCredentialKey(MIPHAM_HOME))

    if (idx >= 0) {
      providers[idx] = { ...providers[idx], apiKey: storedKey }
    } else {
      // Provider not in config — append it
      providers.push({ id: providerId, apiKey: storedKey })
    }

    doc.providers = providers

    // Write back
    writeFileSync(configPath, stringifyYaml(doc), { encoding: 'utf-8', mode: 0o600 })
    return true
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`⚠ Mipham Code: failed to save API key for ${providerId}: ${msg}\n`)
    return false
  }
}
