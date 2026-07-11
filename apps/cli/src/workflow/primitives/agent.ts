import { SubAgent } from '../../agent/sub-agent'
import type { ProviderRegistry } from '../../providers/registry'
import type { ToolDefinition } from '../../shared/index.ts'

export interface WorkflowAgentOpts {
  label?: string
  phase?: string
  schema?: object
  model?: string
  provider?: string
  effort?: 'low' | 'medium' | 'high' | 'max'
}

/**
 * Workflow agent() primitive — creates a SubAgent with optional
 * provider/model override and structured output schema.
 */
export async function workflowAgent(
  prompt: string,
  registry: ProviderRegistry,
  toolRegistry: Map<string, ToolDefinition>,
  opts: WorkflowAgentOpts = {},
): Promise<unknown> {
  // If provider override, switch temporarily
  if (opts.provider) {
    registry.switchProvider(opts.provider, opts.model)
  } else if (opts.model) {
    registry.switchProvider(registry.getActive().config.id, opts.model)
  }

  const sub = new SubAgent(registry, toolRegistry)
  const result = await sub.execute(prompt, opts.label || 'workflow-agent', {
    type: 'general',
    modelOverride: opts.model,
    allowedTools: undefined, // use all tools by default
  })

  // If schema is provided, attempt to parse the result as JSON
  if (opts.schema) {
    try {
      const parsed = JSON.parse(result)
      // Basic validation: return parsed object
      return parsed
    } catch {
      // Return raw text if JSON parse fails
      return { raw: result }
    }
  }

  return result
}
