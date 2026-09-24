import { join } from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { PluginManager } from './plugin-manager'
import type { AgentRegistry } from '../agent/agent-registry'
import type { SkillsLoader } from '../skills/loader'
import type { HookEngine } from '../core/hooks'
import type { McpClient } from '../mcp/client'
import { registerMcpServerTools } from '../mcp/registry'
import { executeHook } from '../core/hooks-executor'
import { detectPluginFormat, isLoadableMcpConfig } from './plugin-validator'
import { loadClaudePlugin } from './claude-plugin'
import type { McpServerConfig, ToolDefinition, HookConfig, HookEvent } from '../shared/types'

/**
 * Activate all enabled plugins — load their agents, skills, MCP servers, and hooks.
 *
 * Called once at startup after the core subsystems (agent registry, skills loader,
 * hook engine, MCP client, tool registry) are initialized.
 */
export function loadPlugins(
  pluginManager: PluginManager,
  agentRegistry: AgentRegistry,
  skillsLoader: SkillsLoader,
  hookEngine: HookEngine,
  mcpClient: McpClient,
  toolsMap: Map<string, ToolDefinition>,
): void {
  for (const plugin of pluginManager.getEnabled()) {
    // Claude marketplace plugins: load their portable content via the adapter.
    if (detectPluginFormat(plugin.path) === 'claude') {
      const claudeMcpServers = loadClaudePlugin(plugin.path, {
        skillsLoader,
        agentRegistry,
        mcpClient,
        toolsMap,
      })
      pluginManager.onRemove(plugin.name, () => {
        for (const serverName of claudeMcpServers) {
          try {
            const toolNames = mcpClient.disconnect(serverName)
            for (const toolName of toolNames) {
              toolsMap.delete(`mcp__${serverName}__${toolName}`)
            }
          } catch {
            /* best effort */
          }
        }
      })
      continue
    }

    const mcpServers: string[] = []

    // ── Custom agents ──
    const agentsDir = join(plugin.path, 'agents')
    if (existsSync(agentsDir)) {
      try {
        agentRegistry.loadDirectory(agentsDir, 'user')
      } catch (err) {
        process.stderr.write(
          `[plugin] Failed to load agents from "${plugin.name}": ${String(err)}\n`,
        )
      }
    }

    // ── Custom skills ──
    const skillsDir = join(plugin.path, 'skills')
    if (existsSync(skillsDir)) {
      try {
        skillsLoader.loadExternal([skillsDir])
      } catch (err) {
        process.stderr.write(
          `[plugin] Failed to load skills from "${plugin.name}": ${String(err)}\n`,
        )
      }
    }

    // ── MCP servers ──
    const mcpDir = join(plugin.path, 'mcp-servers')
    if (existsSync(mcpDir)) {
      try {
        const entries = readdirSync(mcpDir)
        for (const entry of entries) {
          if (!entry.endsWith('.json')) continue
          try {
            const raw = readFileSync(join(mcpDir, entry), 'utf-8')
            const cfg = JSON.parse(raw) as McpServerConfig
            // Both transports, not just the local one. Requiring `command` here used
            // to drop every server declared by `url` — a remote server carries no
            // command — and dropping it in silence, so the plugin looked installed
            // and its tools simply never appeared.
            if (isLoadableMcpConfig(cfg)) {
              mcpServers.push(cfg.name)
              mcpClient
                .connect(cfg)
                .then(() => {
                  const count = registerMcpServerTools(cfg.name, toolsMap)
                  if (count > 0) {
                    process.stderr.write(
                      `[plugin] "${plugin.name}": registered ${count} MCP tools from "${cfg.name}"\n`,
                    )
                  }
                })
                .catch((err: unknown) => {
                  process.stderr.write(
                    `[plugin] Failed to connect MCP "${cfg.name}" from "${plugin.name}": ${String(err)}\n`,
                  )
                })
            } else {
              // Silent skips are the failure this branch exists to end: the operator
              // sees a plugin that loaded and tools that are missing, with nothing
              // connecting the two.
              const declared =
                typeof cfg.name === 'string' && cfg.name !== '' ? ` "MCP server ${cfg.name}"` : ''
              process.stderr.write(
                `[plugin] "${plugin.name}": mcp-servers/${entry}${declared} declares neither command nor url — skipped\n`,
              )
            }
          } catch (err) {
            process.stderr.write(
              `[plugin] "${plugin.name}": mcp-servers/${entry} could not be parsed — skipped: ${String(err)}\n`,
            )
          }
        }
      } catch (err) {
        process.stderr.write(
          `[plugin] Failed to load MCP configs from "${plugin.name}": ${String(err)}\n`,
        )
      }
    }

    // ── Hooks from plugin.json ──
    try {
      const manifestPath = join(plugin.path, 'plugin.json')
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
        if (manifest.hooks && Array.isArray(manifest.hooks)) {
          for (const hookCfg of manifest.hooks as HookConfig[]) {
            if (hookCfg.type && hookCfg) {
              const event = (hookCfg as unknown as Record<string, unknown>).event as
                HookEvent | undefined
              if (event) {
                hookEngine.register({
                  event,
                  // Whoever is running the session can no longer tell this hook from
                  // one they wrote themselves: the failure it prints would name only
                  // its command, its health would be tracked under the bare event
                  // name, and the cleanup below would have nothing to scope to.
                  source: plugin.name,
                  handler: async (ctx) => executeHook(hookCfg, ctx, plugin.name),
                })
              }
            }
          }
        }
      }
    } catch (err) {
      process.stderr.write(`[plugin] Failed to load hooks from "${plugin.name}": ${String(err)}\n`)
    }

    // ── Register cleanup callback ──
    pluginManager.onRemove(plugin.name, () => {
      // Disconnect MCP servers and unregister their tools
      for (const serverName of mcpServers) {
        try {
          const toolNames = mcpClient.disconnect(serverName)
          for (const toolName of toolNames) {
            toolsMap.delete(`mcp__${serverName}__${toolName}`)
          }
        } catch {
          /* best effort */
        }
      }
      // Unregister hooks — this plugin's, and only this plugin's. Keyed by event,
      // this removed every hook on those events: the operator's own from settings
      // and other plugins' alike, silently.
      try {
        hookEngine.unregisterSource(plugin.name)
      } catch {
        /* best effort */
      }
    })
  }
}
