import type { McpServerConfig } from '../shared/types'
import type {
  ConnectionStatus,
  ConnectionInfo,
  ToolDefinition,
  ToolCallResult,
  InitializeResult,
} from './types'
import { StdioTransport } from './transport'
import { McpProtocol } from './protocol'

interface ActiveConnection {
  config: McpServerConfig
  transport: StdioTransport
  protocol: McpProtocol
  status: ConnectionStatus
  tools: ToolDefinition[]
  serverInfo?: { name: string; version: string }
  error?: string
}

/**
 * Singleton MCP client — manages connections to multiple MCP servers.
 *
 * Lifecycle:
 *   1. connect(config) — spawn process, initialize, discover tools
 *   2. callTool(server, tool, params) — execute tool on connected server
 *   3. disconnect(name) or closeAll() — kill subprocess, clean up
 *
 * Backward-compatible with the previous stub McpClient API.
 */
export class McpClient {
  private static instance: McpClient | null = null
  private connections = new Map<string, ActiveConnection>()

  /** Get or create the singleton instance. */
  static getInstance(): McpClient {
    if (!McpClient.instance) {
      McpClient.instance = new McpClient()
    }
    return McpClient.instance
  }

  /** Reset the singleton (useful for testing). */
  static resetInstance(): void {
    McpClient.instance = null
  }

  async connect(config: McpServerConfig): Promise<void> {
    // Skip if already connected
    const existing = this.connections.get(config.name)
    if (existing?.status === 'connected') return

    const transport = new StdioTransport()
    const protocol = new McpProtocol(transport)

    const connection: ActiveConnection = {
      config,
      transport,
      protocol,
      status: 'connecting',
      tools: [],
    }

    this.connections.set(config.name, connection)

    try {
      const initResult: InitializeResult = await protocol.initialize(
        config.command,
        config.args,
        config.env,
      )

      connection.status = 'connected'
      connection.serverInfo = initResult.serverInfo

      // Discover tools
      if (initResult.capabilities.tools) {
        connection.tools = await protocol.listTools()
      }
    } catch (err) {
      connection.status = 'error'
      connection.error = String(err)
      throw err
    }
  }

  disconnect(name: string): void {
    const conn = this.connections.get(name)
    if (!conn) return

    try {
      conn.transport.close()
    } catch { /* best effort */ }
    this.connections.delete(name)
  }

  async closeAll(): Promise<void> {
    const names = Array.from(this.connections.keys())
    for (const name of names) {
      try {
        await this.connections.get(name)?.transport.close()
      } catch { /* best effort */ }
      this.connections.delete(name)
    }
    McpClient.instance = null
  }

  getConnection(name: string): ConnectionInfo | undefined {
    const conn = this.connections.get(name)
    if (!conn) return undefined

    return {
      config: {
        name: conn.config.name,
        command: conn.config.command,
        args: conn.config.args,
      },
      status: conn.status,
      tools: conn.tools,
      error: conn.error,
      serverInfo: conn.serverInfo,
    }
  }

  listConnections(): ConnectionInfo[] {
    return Array.from(this.connections.values()).map(conn => ({
      config: {
        name: conn.config.name,
        command: conn.config.command,
        args: conn.config.args,
      },
      status: conn.status,
      tools: conn.tools,
      error: conn.error,
      serverInfo: conn.serverInfo,
    }))
  }

  getTools(name: string): ToolDefinition[] {
    return this.connections.get(name)?.tools || []
  }

  async callTool(
    serverName: string,
    toolName: string,
    params?: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const conn = this.connections.get(serverName)
    if (!conn || conn.status !== 'connected') {
      return {
        content: [{ type: 'text', text: `Error: MCP server "${serverName}" not connected` }],
        isError: true,
      }
    }

    try {
      return await conn.protocol.callTool(toolName, params)
    } catch (err) {
      return {
        content: [{ type: 'text', text: `MCP tool error: ${String(err)}` }],
        isError: true,
      }
    }
  }
}
