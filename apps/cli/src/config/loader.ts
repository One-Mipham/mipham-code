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
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { atomicWriteFileSync } from '../shared/atomic-write'
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
import type { SettingsHooks } from '../core/hooks-config'

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
    // This array comes straight out of hand-written YAML: an entry can be
    // `null`, or a bare scalar (iterating `providers: nope` yields its
    // characters). Neither is a provider config, and neither should reach the
    // field reads below.
    if (!op || typeof op !== 'object') continue

    // A non-string `apiKey` (a number, a list, a nested map) is not a secret.
    // It reads as "no key" — the same invariant getProviderApiKey enforces —
    // rather than reaching a `.startsWith` and taking the whole CLI down.
    const apiKey = typeof op.apiKey === 'string' ? op.apiKey : undefined

    const idx = merged.findIndex((bp) => bp.id === op.id)
    if (idx === -1) {
      // Provider not in defaults — add it wholesale (custom provider)
      merged.push(apiKey === undefined ? op : { ...op, apiKey })
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
      apiKey: apiKey ?? base.apiKey,
      models: op.models?.length ? op.models : base.models,
      status: op.status ?? base.status,
    }
  }

  return merged
}

/**
 * Merge `override` into `base`, recursing into plain objects so that a source
 * setting one branch of an object does not drop the other source's siblings
 * (`features.mcp` must not wipe `features.context`).
 *
 * Arrays and scalars replace: a project's `skills.paths` must not append to the
 * user's list. Objects are rebuilt with spread rather than assignment — a parsed
 * `__proto__` key is then copied as an ordinary own property instead of
 * mutating the result's prototype.
 */
function mergeObjects<T extends Record<string, unknown>>(base: T, override: T): T {
  let merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const existing = (base as Record<string, unknown>)[key]
    merged = {
      ...merged,
      [key]:
        isPlainObject(value) && isPlainObject(existing) ? mergeObjects(existing, value) : value,
    }
  }
  return merged as T
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeConfig(
  base: MiphamConfig,
  override: Partial<MiphamConfig>,
  allowBaseUrlOverride: boolean,
): MiphamConfig {
  const merged = mergeObjects(
    base as unknown as Record<string, unknown>,
    override as Record<string, unknown>,
  ) as unknown as MiphamConfig
  if (override.providers) {
    merged.providers = mergeProviders(base.providers, override.providers, allowBaseUrlOverride)
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
export function tryRestoreFromBackup(configPath: string): boolean {
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
      // Every McpServerConfig field is optional here (the name comes from the
      // key), so a field added to the type is accepted without touching this.
      const parsed = JSON.parse(raw) as {
        mcpServers?: Record<string, Partial<McpServerConfig>>
      }

      if (parsed.mcpServers) {
        for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
          // Avoid duplicates by name
          if (servers.some((s) => s.name === name)) continue
          // Spread the whole entry rather than re-listing fields: hand-rebuilding
          // the object silently dropped request_timeout_ms and auth.
          servers.push({ ...cfg, name, args: cfg.args || [] })
        }
      }
    } catch {
      // Silently skip malformed or missing .mcp.json files
    }
  }

  return servers
}

/**
 * Parsed `settings.json` (Claude Code convention): hooks + permissions.
 * Hooks are additive across levels; permissions allow/deny are deduped unions.
 */
export interface SettingsJson {
  hooks: SettingsHooks
  permissions: { allow: string[]; deny: string[] }
}

/**
 * Load `settings.json` — project-level `.mipham/settings.json` then user-level
 * `~/.mipham/settings.json`. Mirrors the Claude Code convention (hooks additive,
 * permissions merged), so users can migrate their Claude settings unchanged.
 */
export function loadSettingsJson(cwd: string = process.cwd()): SettingsJson {
  const hooks: SettingsHooks = {}
  const permissions = { allow: [] as string[], deny: [] as string[] }

  const searchPaths = [join(cwd, '.mipham', 'settings.json'), join(MIPHAM_HOME, 'settings.json')]

  for (const path of searchPaths) {
    try {
      if (!existsSync(path)) continue
      const raw = readFileSync(path, 'utf-8')
      const parsed = JSON.parse(raw) as {
        hooks?: Record<string, unknown>
        permissions?: { allow?: unknown; deny?: unknown }
      }

      if (parsed.hooks && typeof parsed.hooks === 'object') {
        for (const [eventName, entries] of Object.entries(parsed.hooks)) {
          if (!Array.isArray(entries)) continue
          const bucket = (hooks as Record<string, unknown[]>)[eventName]
          ;(hooks as Record<string, unknown[]>)[eventName] = [...(bucket ?? []), ...entries]
        }
      }

      if (parsed.permissions) {
        for (const key of ['allow', 'deny'] as const) {
          const list = parsed.permissions[key]
          if (!Array.isArray(list)) continue
          for (const p of list) {
            if (typeof p === 'string' && !permissions[key].includes(p)) permissions[key].push(p)
          }
        }
      }
    } catch {
      // Silently skip malformed or missing settings.json files
    }
  }

  return { hooks, permissions }
}

/** Which settings.json a permission rule is persisted to. */
export type SettingsScope = 'project' | 'user'

export function settingsPathFor(scope: SettingsScope, cwd: string = process.cwd()): string {
  return scope === 'user'
    ? join(MIPHAM_HOME, 'settings.json')
    : join(cwd, '.mipham', 'settings.json')
}

/**
 * Read a settings.json as a plain object, preserving any key we don't model
 * (hooks, and anything a future version adds). A malformed file is an error,
 * not something to clobber — the user's other settings live in the same file.
 */
export function readSettingsDoc(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    throw new Error(`${path} is not valid JSON. Fix or remove it, then retry.`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON object. Fix or remove it, then retry.`)
  }
  return parsed as Record<string, unknown>
}

export function writeSettingsDoc(path: string, doc: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  atomicWriteFileSync(path, JSON.stringify(doc, null, 2) + '\n')
}

/**
 * Persist one rule into `permissions.<key>` of a scope's settings.json.
 * Idempotent: re-adding an existing rule leaves the file unchanged.
 * Returns the path written.
 */
export function addSettingsRule(
  key: 'allow' | 'deny',
  rule: string,
  scope: SettingsScope = 'project',
  cwd: string = process.cwd(),
): string {
  const path = settingsPathFor(scope, cwd)
  const doc = readSettingsDoc(path)
  const perms = (doc.permissions ?? {}) as Record<string, unknown>
  const list = Array.isArray(perms[key]) ? perms[key] : []
  const strings = (list as unknown[]).filter((r): r is string => typeof r === 'string')
  if (!strings.includes(rule)) strings.push(rule)
  perms[key] = strings
  doc.permissions = perms
  writeSettingsDoc(path, doc)
  return path
}

/**
 * Remove a rule from whichever `permissions` list holds it. Returns the path
 * and key it was removed from, or null when the rule was not present.
 */
export function removeSettingsRule(
  rule: string,
  scope: SettingsScope = 'project',
  cwd: string = process.cwd(),
): { path: string; key: 'allow' | 'deny' } | null {
  const path = settingsPathFor(scope, cwd)
  const doc = readSettingsDoc(path)
  const perms = (doc.permissions ?? {}) as Record<string, unknown>

  for (const key of ['allow', 'deny'] as const) {
    if (!Array.isArray(perms[key])) continue
    const list = (perms[key] as unknown[]).filter((r): r is string => typeof r === 'string')
    if (!list.includes(rule)) continue
    perms[key] = list.filter((r) => r !== rule)
    doc.permissions = perms
    writeSettingsDoc(path, doc)
    return { path, key }
  }
  return null
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
        reminder: config.skills?.reminder,
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
  // Same invariant as getProviderApiKey: only a string can carry the `enc:v1:`
  // prefix, so a malformed entry counts as "no key" instead of throwing on
  // `.startsWith` and taking the whole CLI down at startup.
  const isEncrypted = (p: ProviderConfig | null): boolean =>
    !!p && typeof p.apiKey === 'string' && p.apiKey.startsWith(ENC_PREFIX)
  if (!providers.some(isEncrypted)) return
  const key = getCredentialKey(MIPHAM_HOME)
  for (const p of providers) {
    if (!isEncrypted(p)) continue
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
    atomicWriteFileSync(configPath, stringifyYaml(doc), { mode: 0o600 })
    return true
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`⚠ Mipham Code: failed to save API key for ${providerId}: ${msg}\n`)
    return false
  }
}
