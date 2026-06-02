import type { ToolDefinition } from './shared/index.ts'

export const webSearchTool: ToolDefinition = {
  name: 'WebSearch',
  description: 'Search the web. Returns result titles and URLs.',
  category: 'network',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 2, description: 'Search query' },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include results from these domains',
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Never include results from these domains',
      },
    },
    required: ['query'],
  },
  async execute(params, _ctx) {
    const query = params.query as string
    return {
      success: true,
      content: `WebSearch query: "${query}". Results would appear here when search API is configured.`,
    }
  },
}
