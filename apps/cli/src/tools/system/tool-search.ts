/**
 * ToolSearch — search MCP server tools by name or description.
 *
 * Instead of loading all MCP tool definitions into the context upfront,
 * the AI can call ToolSearch to discover relevant tools on demand.
 * This saves ~85% of context tokens for large MCP servers (50-100 tools).
 */

import type { ToolDefinition } from '../../shared/index.ts'
import { McpClient } from '../../mcp/client'

export const toolSearchTool: ToolDefinition = {
  name: 'ToolSearch',
  description:
    'Search available MCP server tools by name or description. ' +
    'Use this to discover tools on demand instead of loading all tool definitions into context. ' +
    'Returns matching tool names with their server and description.',
  category: 'system',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Search query — matches against tool names and descriptions. Leave empty to list all available MCP tools.',
      },
      server: {
        type: 'string',
        description: 'Optional: limit search to a specific MCP server name.',
      },
      limit: {
        type: 'integer',
        description: 'Max results to return (default: 20).',
      },
    },
    required: [],
  },
  async execute(params, _ctx) {
    const query = ((params.query as string) || '').toLowerCase()
    const serverFilter = (params.server as string) || ''
    const limit = (params.limit as number) || 20

    const client = McpClient.getInstance()
    const connectedServers = client.getConnectedServers()

    if (connectedServers.length === 0) {
      return {
        success: true,
        content:
          '── MCP Tool Search ──\n\n' +
          'No MCP servers connected.\n\n' +
          'Connect MCP servers in .mcp.json or via /mcp add <name> <url>.',
      }
    }

    // Filter by server if specified
    const servers = serverFilter
      ? connectedServers.filter((s) => s.toLowerCase().includes(serverFilter))
      : connectedServers

    if (serverFilter && servers.length === 0) {
      return {
        success: true,
        content:
          `── MCP Tool Search ──\n\n` +
          `No connected server matching "${serverFilter}".\n\n` +
          `Connected servers: ${connectedServers.join(', ')}`,
      }
    }

    // Collect matching tools
    interface Match {
      server: string
      tool: string
      description: string
    }

    const matches: Match[] = []

    for (const serverName of servers) {
      try {
        const tools = client.getTools(serverName)
        for (const tool of tools) {
          const nameMatch = !query || tool.name.toLowerCase().includes(query)
          const descMatch =
            !query || (tool.description || '').toLowerCase().includes(query)
          if (nameMatch || descMatch) {
            matches.push({
              server: serverName,
              tool: tool.name,
              description: (tool.description || '').slice(0, 120),
            })
          }
        }
      } catch {
        // Server disconnected mid-search — skip
      }
    }

    if (matches.length === 0) {
      return {
        success: true,
        content:
          `── MCP Tool Search ──\n\n` +
          `No tools matching "${query}" across ${servers.length} server(s).\n\n` +
          `Try a different query, or omit the query to list all tools.`,
      }
    }

    // Truncate to limit
    const limited = matches.slice(0, limit)

    const lines: string[] = [
      `── MCP Tool Search ──`,
      '',
      `${limited.length} of ${matches.length} matching tool(s) across ${servers.length} server(s):`,
      '',
    ]

    // Group by server
    const byServer = new Map<string, Match[]>()
    for (const m of limited) {
      const list = byServer.get(m.server) || []
      list.push(m)
      byServer.set(m.server, list)
    }

    for (const [server, tools] of byServer) {
      lines.push(`  ${server} (${tools.length}):`)
      for (const t of tools) {
        const desc = t.description ? ` — ${t.description}` : ''
        lines.push(`    mcp__${server.replace(/[^a-z0-9-]/g, '_')}__${t.tool}${desc}`)
      }
      lines.push('')
    }

    if (matches.length > limit) {
      lines.push(`... and ${matches.length - limit} more. Use "query" to narrow results.`)
    }

    return { success: true, content: lines.join('\n') }
  },
}
