import type { ToolDefinition } from '@mipham/shared'

export const planTool: ToolDefinition = {
  name: 'Plan',
  description:
    'Enter plan mode — read-only analysis and design, no code execution.',
  category: 'agent',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute(_params, _ctx) {
    return {
      success: true,
      content:
        'Plan mode activated. The AI will analyze and design without executing any code changes.',
    }
  },
}
