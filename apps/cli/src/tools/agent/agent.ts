import type { ToolDefinition } from './shared/index.ts'

export const agentTool: ToolDefinition = {
  name: 'Agent',
  description:
    'Launch a sub-agent to handle complex, multi-step tasks independently.',
  category: 'agent',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short description of the task' },
      prompt: { type: 'string', description: 'The task for the agent to perform' },
      subagent_type: { type: 'string', description: 'Type of specialized agent' },
    },
    required: ['description', 'prompt'],
  },
  async execute(params, _ctx) {
    const description = params.description as string
    const prompt = params.prompt as string
    return {
      success: true,
      content: `[Agent dispatched]\nTask: ${description}\nPrompt: ${prompt}\n\nAgent result would appear here. Full agent subsystem in M3.`,
    }
  },
}
