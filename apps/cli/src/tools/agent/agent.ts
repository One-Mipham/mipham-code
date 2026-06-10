import type { ToolDefinition } from '../shared/index.ts'
import { SubAgent, type SubAgentType } from '../../agent/sub-agent'

const VALID_TYPES: SubAgentType[] = ['general', 'explore', 'plan', 'code-review']

export const agentTool: ToolDefinition = {
  name: 'Agent',
  description:
    'Launch a sub-agent to handle complex, multi-step tasks independently. Available types: general, explore, plan, code-review.',
  category: 'agent',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short description of the task' },
      prompt: { type: 'string', description: 'The task for the agent to perform' },
      subagent_type: {
        type: 'string',
        description: 'Type: general (default), explore (code search), plan (design), code-review',
      },
    },
    required: ['description', 'prompt'],
  },
  async execute(params, ctx) {
    const description = params.description as string
    const prompt = params.prompt as string
    const agentType = (params.subagent_type as SubAgentType) || 'general'

    if (!VALID_TYPES.includes(agentType)) {
      return {
        success: false,
        content: '',
        error: `Invalid subagent_type "${agentType}". Valid types: ${VALID_TYPES.join(', ')}`,
      }
    }

    const registry = ctx.registry
    if (!registry) {
      // No registry in context — return structured simulation
      const sub = new SubAgent(null as unknown as import('../../providers/registry').ProviderRegistry)
      const result = await sub.execute(prompt, description, { type: agentType })
      return { success: true, content: result }
    }

    const sub = new SubAgent(registry)
    const result = await sub.execute(prompt, description, { type: agentType })
    return { success: true, content: result }
  },
}
