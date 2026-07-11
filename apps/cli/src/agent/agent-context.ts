// apps/cli/src/agent/agent-context.ts
import { ContextManager } from '../core/context'
import type { ToolDefinition } from '../shared/index.ts'
import type { AgentDefinition } from './types'

export interface AgentContextResult {
  context: ContextManager
  allowedTools: ToolDefinition[]
}

/**
 * Create an isolated context and tool set for a sub-agent.
 *
 * Tool scoping rules (first match wins):
 * 1. If `tools` is set, only those tools are allowed.
 * 2. If `disallowedTools` is set, those are removed from the full set.
 * 3. If neither is set, all tools are available.
 */
export function createAgentContext(
  agentDef: AgentDefinition,
  toolRegistry: Map<string, ToolDefinition>,
  contextWindow?: number,
): AgentContextResult {
  // Create isolated context
  const context = new ContextManager({
    maxTokens: contextWindow || 100_000,
    compactionThreshold: 0.85,
  })

  context.setSystemPrompt(agentDef.systemPrompt)

  // Scope tools
  let allowedTools = Array.from(toolRegistry.values())

  if (agentDef.tools) {
    const allowSet = new Set(
      agentDef.tools.split(',').map(s => s.trim()).filter(Boolean)
    )
    allowedTools = allowedTools.filter(t => allowSet.has(t.name))
  }

  if (agentDef.disallowedTools) {
    const denySet = new Set(
      agentDef.disallowedTools.split(',').map(s => s.trim()).filter(Boolean)
    )
    allowedTools = allowedTools.filter(t => !denySet.has(t.name))
  }

  return { context, allowedTools }
}
