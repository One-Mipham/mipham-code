import { join } from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { PluginManager } from './plugin-manager'
import type { AgentRegistry } from '../agent/agent-registry'
import type { SkillsLoader } from '../skills/loader'
import type { HookEngine } from '../core/hooks'
import type { McpClient } from '../mcp/client'
import { registerMcpServerTools } from '../mcp/registry'
import { executeHook } from '../core/hooks-executor'
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
    const mcpServers: string[] = []
    const hookEvents: HookEvent[] = []

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
            if (cfg.name && cfg.command) {
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
            }
          } catch {
            // skip unparseable MCP config files
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
                hookEvents.push(event)
                hookEngine.register({
                  event,
                  handler: async (ctx) => executeHook(hookCfg, ctx),
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
      // Unregister hooks
      for (const event of hookEvents) {
        try {
          hookEngine.unregister(event)
        } catch {
          /* best effort */
        }
      }
    })
  }
}
