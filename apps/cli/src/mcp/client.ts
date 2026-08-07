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
import { OAuthClient } from './oauth'
import { TokenStore } from './token-store'
import { createT } from '../i18n-core/t'
import enUS from '../i18n-core/locales/en-US.json'
import zhCN from '../i18n-core/locales/zh-CN.json'
import type { TranslationMap } from '../i18n-core/types'

const bundles: Record<string, TranslationMap> = {
  'en-US': enUS as TranslationMap,
  'zh-CN': zhCN as TranslationMap,
}
const t = createT(bundles['en-US'] || (enUS as TranslationMap), enUS as TranslationMap)

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
  private _tokenStore: TokenStore | null = null
  private _oauthClient: OAuthClient | null = null
  private eventHandlers = new Map<string, Array<(...args: any[]) => void>>()

  private get tokenStore(): TokenStore {
    if (!this._tokenStore) this._tokenStore = new TokenStore()
    return this._tokenStore
  }

  private get oauthClient(): OAuthClient {
    if (!this._oauthClient) this._oauthClient = new OAuthClient(this.tokenStore)
    return this._oauthClient
  }

  /** Get or create the singleton instance. */
  static getInstance(): McpClient {
    if (!McpClient.instance) {
      McpClient.instance = new McpClient()
    }
    return McpClient.instance
  }

  on(event: string, handler: (...args: any[]) => void): void {
    const list = this.eventHandlers.get(event) || []
    list.push(handler)
    this.eventHandlers.set(event, list)
  }

  private emit(event: string, ...args: any[]): void {
    const list = this.eventHandlers.get(event) || []
    for (const h of list) h(...args)
  }

  /** Connect with OAuth PKCE flow — injects access token into env vars. */
  async connectWithOAuth(config: McpServerConfig): Promise<void> {
    const accessToken = await this.oauthClient.getValidAccessToken(config.name, config)
    return this.connect({
      ...config,
      env: { ...config.env, MCP_ACCESS_TOKEN: accessToken },
    })
  }

  /** Handle tools/list_changed notification — diff and re-register. */
  async onToolsChanged(name: string): Promise<void> {
    const connection = this.connections.get(name)
    if (!connection || connection.status !== 'connected') return

    const oldToolNames = new Set(connection.tools.map((t) => t.name))
    const newTools = await connection.protocol.listTools()
    const newToolNames = new Set(newTools.map((t) => t.name))

    const added = newTools.filter((t) => !oldToolNames.has(t.name))
    const removed = connection.tools.filter((t) => !newToolNames.has(t.name))

    connection.tools = newTools

    if (added.length > 0 || removed.length > 0) {
      this.emit('tools-changed', name, added, removed)
    }
  }

  /** Reconnect with exponential backoff (1s→2s→4s→…max 60s, 10 attempts). */
  async reconnect(name: string): Promise<void> {
    const connection = this.connections.get(name)
    if (!connection) throw new Error(t('errors.mcp_no_connection', { name }))

    const config = connection.config
    let delay = 1000
    const maxDelay = 60000
    const maxAttempts = 10

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        try {
          connection.transport.close()
        } catch {
          /* ok */
        }
        this.connections.delete(name)

        await this.connect(config)
        this.emit('reconnected', name)
        return
      } catch (err) {
        if (attempt === maxAttempts) {
          connection.status = 'error'
          connection.error = String(err)
          this.emit('disconnected', name, err)
          throw err
        }
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, maxDelay)
      }
    }
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

      // Wire tools-changed notification
      protocol.on('tools-changed', async () => {
        await this.onToolsChanged(config.name)
      })

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

  /**
   * Disconnect an MCP server and return the names of its registered tools
   * so the caller can unregister them from the central tool registry.
   */
  disconnect(name: string): string[] {
    const conn = this.connections.get(name)
    if (!conn) return []

    try {
      conn.transport.close()
    } catch {
      /* best effort */
    }
    const toolNames = conn.tools.map((t) => t.name)
    this.connections.delete(name)
    return toolNames
  }

  async closeAll(): Promise<void> {
    const names = Array.from(this.connections.keys())
    for (const name of names) {
      try {
        await this.connections.get(name)?.transport.close()
      } catch {
        /* best effort */
      }
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
    return Array.from(this.connections.values()).map((conn) => ({
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

  /** List all currently connected MCP server names. */
  getConnectedServers(): string[] {
    const names: string[] = []
    for (const [name, conn] of this.connections) {
      if (conn.status === 'connected') names.push(name)
    }
    return names
  }

  async callTool(
    serverName: string,
    toolName: string,
    params?: Record<string, unknown>,
  ): Promise<ToolCallResult> {
    const conn = this.connections.get(serverName)
    if (!conn || conn.status !== 'connected') {
      return {
        content: [{ type: 'text', text: t('errors.mcp_not_connected', { server: serverName }) }],
        isError: true,
      }
    }

    try {
      return await conn.protocol.callTool(toolName, params)
    } catch (err) {
      return {
        content: [{ type: 'text', text: t('errors.mcp_tool_error', { error: String(err) }) }],
        isError: true,
      }
    }
  }
}
