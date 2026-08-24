import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillsLoader } from '../skills/loader'
import type { AgentRegistry } from '../agent/agent-registry'
import type { McpClient } from '../mcp/client'
import type { McpServerConfig, ToolDefinition } from '../shared/types'
import { registerMcpServerTools } from '../mcp/registry'

/**
 * Claude marketplace plugin adapter — loads the portable content of a Claude
 * plugin (`.claude-plugin/plugin.json` + skills/agents/MCP) into Mipham Code's
 * own subsystems. Commands (`commands/*.md`) and hooks (`hooks/hooks.json`) are
 * not mapped here: Mipham Code has no file-based slash-command system, and the
 * hook matcher semantics differ.
 */

interface ClaudeManifest {
  name: string
  version?: string
  mcpServers?: Record<string, unknown> | string
  [key: string]: unknown
}

/** Read the Claude manifest at `<dir>/.claude-plugin/plugin.json`. */
export function readClaudeManifest(dir: string): ClaudeManifest | null {
  const path = join(dir, '.claude-plugin', 'plugin.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ClaudeManifest
  } catch {
    return null
  }
}

/** Expand `${CLAUDE_PLUGIN_ROOT}` (Claude's plugin-root placeholder). */
function expandPluginRoot(value: string, pluginRoot: string): string {
  return value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
}

/** Load Claude skills — `skills/<name>/SKILL.md` (no leading dot on SKILL.md). */
function loadClaudeSkills(dir: string, skillsLoader: SkillsLoader): void {
  const skillsDir = join(dir, 'skills')
  if (!existsSync(skillsDir)) return
  let entries: string[] = []
  try {
    entries = readdirSync(skillsDir)
  } catch {
    return
  }
  for (const entry of entries) {
    let skillFile: string | null = null
    try {
      const full = join(skillsDir, entry)
      if (statSync(full).isDirectory()) {
        const candidate = join(full, 'SKILL.md')
        if (existsSync(candidate)) skillFile = candidate
      } else if (entry === 'SKILL.md') {
        skillFile = full
      }
    } catch {
      continue
    }
    if (skillFile) skillsLoader.loadSkillFile(skillFile, 'standard')
  }
}

/** Map a Claude MCP server entry to a Mipham `McpServerConfig`. */
function toMcpServerConfig(name: string, raw: Record<string, unknown>): McpServerConfig | null {
  const command = typeof raw.command === 'string' ? raw.command : undefined
  const url = typeof raw.url === 'string' ? raw.url : undefined
  if (!command && !url) return null

  const cfg: McpServerConfig = { name }
  if (command) {
    cfg.command = command
    cfg.args = Array.isArray(raw.args) ? raw.args.map(String) : undefined
  } else {
    cfg.url = url
  }
  if (raw.env && typeof raw.env === 'object') {
    cfg.env = raw.env as Record<string, string>
  }
  if (raw.headers && typeof raw.headers === 'object') {
    cfg.headers = raw.headers as Record<string, string>
  }
  return cfg
}

/** Load Claude MCP servers (`.mcp.json` + inline `mcpServers`) into the client. */
function loadClaudeMcp(
  dir: string,
  manifest: ClaudeManifest,
  mcpClient: Pick<McpClient, 'connect'>,
  toolsMap: Map<string, ToolDefinition>,
): string[] {
  const servers: McpServerConfig[] = []

  const collect = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object') return
    for (const [name, raw] of Object.entries(obj as Record<string, Record<string, unknown>>)) {
      const cfg = toMcpServerConfig(name, raw)
      if (cfg) servers.push(cfg)
    }
  }

  // 1. `.mcp.json` at the plugin root
  const mcpJsonPath = join(dir, '.mcp.json')
  if (existsSync(mcpJsonPath)) {
    try {
      collect(JSON.parse(readFileSync(mcpJsonPath, 'utf-8')).mcpServers)
    } catch {
      /* skip unparseable .mcp.json */
    }
  }
  // 2. Inline `mcpServers` field in the manifest
  collect(manifest.mcpServers)

  for (const cfg of servers) {
    if (cfg.command) cfg.command = expandPluginRoot(cfg.command, dir)
    if (cfg.args) cfg.args = cfg.args.map((a) => expandPluginRoot(a, dir))
    if (cfg.env) {
      for (const key of Object.keys(cfg.env)) cfg.env[key] = expandPluginRoot(cfg.env[key]!, dir)
    }

    mcpClient
      .connect(cfg)
      .then(() => {
        const count = registerMcpServerTools(cfg.name, toolsMap)
        if (count > 0) {
          process.stderr.write(
            `[plugin] "${manifest.name}": registered ${count} MCP tools from "${cfg.name}"\n`,
          )
        }
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `[plugin] Failed to connect MCP "${cfg.name}" from "${manifest.name}": ${String(err)}\n`,
        )
      })
  }

  return servers.map((s) => s.name)
}

/** Load a Claude plugin's portable content (skills + agents + MCP) into Mipham Code.
 *  Returns the names of the connected MCP servers so the caller can wire cleanup. */
export function loadClaudePlugin(
  dir: string,
  deps: {
    skillsLoader: SkillsLoader
    agentRegistry: AgentRegistry
    mcpClient: Pick<McpClient, 'connect'>
    toolsMap: Map<string, ToolDefinition>
  },
): string[] {
  const manifest = readClaudeManifest(dir)
  if (!manifest) return []

  loadClaudeSkills(dir, deps.skillsLoader)

  // Claude agents use `.md` + frontmatter; largely compatible with Mipham's AgentDefinition.
  const agentsDir = join(dir, 'agents')
  if (existsSync(agentsDir)) {
    try {
      deps.agentRegistry.loadDirectory(agentsDir, 'user')
    } catch (err) {
      process.stderr.write(
        `[plugin] Failed to load agents from "${manifest.name}": ${String(err)}\n`,
      )
    }
  }

  return loadClaudeMcp(dir, manifest, deps.mcpClient, deps.toolsMap)
}
