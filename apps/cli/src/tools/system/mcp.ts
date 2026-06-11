import type { ToolDefinition } from '../../shared/index.ts'
import { McpClient } from '../../mcp/client'

export const mcpTool: ToolDefinition = {
  name: 'MCP',
  description:
    'Interact with MCP (Model Context Protocol) servers. Call tools on connected MCP servers via JSON-RPC 2.0 over stdio.',
  category: 'system',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: 'MCP server name as configured in .mipham/config.yml',
      },
      tool: { type: 'string', description: 'Tool name on the MCP server' },
      params: { type: 'object', description: 'Parameters to pass to the tool' },
    },
    required: ['server', 'tool'],
  },
  async execute(params, _ctx) {
    const server = params.server as string
    const toolName = params.tool as string
    const toolParams = (params.params as Record<string, unknown>) || {}

    const client = McpClient.getInstance()
    const connection = client.getConnection(server)

    if (!connection) {
      return {
        success: false,
        content: '',
        error: `MCP server "${server}" is not configured.\n\nAdd it to .mipham/config.yml under skills.mcpServers, or check available servers with /mcp.`,
      }
    }

    if (connection.status !== 'connected') {
      return {
        success: false,
        content: '',
        error: `MCP server "${server}" is not connected (status: ${connection.status}).\n${connection.error ? 'Error: ' + connection.error : 'Use /mcp to check status.'}`,
      }
    }

    // Check if the requested tool exists on this server
    const toolExists = connection.tools.some((t) => t.name === toolName)
    if (!toolExists) {
      const availableTools = connection.tools.map((t) => `  • ${t.name}`).join('\n')
      return {
        success: false,
        content: '',
        error: `Tool "${toolName}" not found on MCP server "${server}".\n\nAvailable tools:\n${availableTools || '  (none discovered)'}`,
      }
    }

    // Execute the tool via the MCP client
    const result = await client.callTool(server, toolName, toolParams)

    // Format the result content
    const text = result.content
      .map((c) => {
        if (c.type === 'text' && c.text) return c.text
        if (c.type === 'image') return `[Image: ${c.mimeType || 'unknown'}]`
        return JSON.stringify(c)
      })
      .join('\n')

    return {
      success: !result.isError,
      content: text || '(empty result)',
      error: result.isError ? text : undefined,
    }
  },
}
