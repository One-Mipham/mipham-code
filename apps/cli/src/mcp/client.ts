import type { McpServerConfig } from './shared/index.ts'

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface McpClientConnection {
  config: McpServerConfig
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  tools: McpTool[]
  error?: string
}

/**
 * MCP (Model Context Protocol) client.
 * Connects to MCP servers via stdio and discovers/executes tools.
 * Phase 1: stub implementation with connection tracking.
 */
export class McpClient {
  private connections = new Map<string, McpClientConnection>()

  async connect(config: McpServerConfig): Promise<void> {
    const existing = this.connections.get(config.name)
    if (existing?.status === 'connected') return

    this.connections.set(config.name, {
      config,
      status: 'connecting',
      tools: [],
    })

    try {
      // Phase 1: stub — mark as connected
      // Phase 2 will implement full stdio MCP protocol:
      //   - Spawn the command process
      //   - Send initialize request
      //   - Discover tools via tools/list
      //   - Handle bidirectional JSON-RPC messages
      this.connections.set(config.name, {
        config,
        status: 'connected',
        tools: [],
      })
    } catch (err) {
      this.connections.set(config.name, {
        config,
        status: 'error',
        tools: [],
        error: String(err),
      })
      throw err
    }
  }

  disconnect(name: string): void {
    this.connections.delete(name)
  }

  getConnection(name: string): McpClientConnection | undefined {
    return this.connections.get(name)
  }

  listConnections(): McpClientConnection[] {
    return Array.from(this.connections.values())
  }

  getTools(name: string): McpTool[] {
    return this.connections.get(name)?.tools || []
  }

  async callTool(
    serverName: string,
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<{ success: boolean; content: string; error?: string }> {
    const conn = this.connections.get(serverName)
    if (!conn || conn.status !== 'connected') {
      return {
        success: false,
        content: '',
        error: `MCP server "${serverName}" not connected`,
      }
    }

    // Phase 1: stub
    return {
      success: true,
      content: `[MCP ${serverName}/${toolName}] Called with params: ${JSON.stringify(params)}`,
    }
  }
}
