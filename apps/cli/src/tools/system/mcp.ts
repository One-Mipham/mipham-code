import type { ToolDefinition } from './shared/index.ts'

export const mcpTool: ToolDefinition = {
  name: 'MCP',
  description: 'Interact with MCP (Model Context Protocol) servers.',
  category: 'system',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server name' },
      tool: { type: 'string', description: 'Tool name on the MCP server' },
      params: { type: 'object', description: 'Parameters for the tool' },
    },
    required: ['server', 'tool'],
  },
  async execute(params, _ctx) {
    const server = params.server as string
    const toolName = params.tool as string
    return {
      success: true,
      content: `MCP call: ${server}/${toolName}. Full MCP client integration in progress.`,
    }
  },
}
