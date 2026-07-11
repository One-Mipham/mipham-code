import type { PluginManager } from './plugin-manager'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export function loadPlugins(
  pluginManager: PluginManager,
  engine: unknown,
  skillsLoader: unknown,
): void {
  for (const plugin of pluginManager.getEnabled()) {
    // Load custom agents
    const agentsDir = join(plugin.path, 'agents')
    if (existsSync(agentsDir)) {
      // → register with AgentRegistry
    }

    // Load custom skills
    const skillsDir = join(plugin.path, 'skills')
    if (existsSync(skillsDir)) {
      // → register with SkillsLoader
    }

    // Load MCP servers
    const mcpDir = join(plugin.path, 'mcp-servers')
    if (existsSync(mcpDir)) {
      // → register MCP configs
    }

    // Load hooks
    // → parse plugin.json hooks → register with HookEngine
  }

  // Suppress unused parameter warnings — these are wiring stubs for future phases
  void engine
  void skillsLoader
}
