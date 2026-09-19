import type { McpServerConfig } from '../shared/types'
import type {
  ConnectionStatus,
  ConnectionInfo,
  ToolDefinition,
  ToolCallResult,
  InitializeResult,
} from './types'
import { StdioTransport, type Transport } from './transport'
import { HttpTransport } from './http-transport'
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

// Connect-handshake timeout: a hung MCP server should fail startup fast rather
// than block on the per-request 60s timeout. Overridable via env for tests.
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

function connectTimeoutMs(): number {
  const env = Number(process.env.MIPHAM_MCP_CONNECT_TIMEOUT_MS)
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_CONNECT_TIMEOUT_MS
}

// A server may emit `notifications/tools/list_changed` once per tool it adds, or
// in a tight loop. Each notification used to trigger its own `tools/list` round
// trip plus a full downstream re-registration, so a burst produced sustained CPU
// and a re-registration storm. Notifications are coalesced into one refresh per
// window instead.
const TOOLS_CHANGED_DEBOUNCE_MS = 250
// Ceiling on the coalescing window — a server that notifies without pause would
// otherwise keep pushing the refresh out forever.
const TOOLS_CHANGED_MAX_DELAY_MS = 2_000

interface ActiveConnection {
  config: McpServerConfig
  transport: Transport
  protocol: McpProtocol
  status: ConnectionStatus
  tools: ToolDefinition[]
  serverInfo?: { name: string; version: string }
  error?: string
  /** Coalescing timer for `tools/list_changed` (see scheduleToolsRefresh). */
  toolsRefreshTimer?: ReturnType<typeof setTimeout>
  /** When the last refresh started — caps the coalescing window. */
  toolsRefreshedAt?: number
  /** A `tools/list` round trip is in flight. */
  toolsRefreshInFlight?: boolean
  /** A notification arrived mid-flight: run exactly one more refresh after. */
  toolsRefreshQueued?: boolean
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

  /**
   * Handle a `tools/list_changed` notification — diff and re-register.
   *
   * Returns immediately: the actual `tools/list` round trip is coalesced
   * (see `scheduleToolsRefresh`), so a burst of notifications does not fan out
   * into a burst of round trips.
   */
  onToolsChanged(name: string): void {
    this.scheduleToolsRefresh(name)
  }

  /** Fetch the tool list and emit `tools-changed` when it actually differs. */
  private async applyToolsChanged(name: string): Promise<void> {
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

  /**
   * Coalesce a `tools/list_changed` notification into a single refresh.
   *
   * Rapid notifications (one per added tool, or a server stuck in a loop) become
   * one `tools/list` round trip per window rather than one each. The window is
   * capped by `TOOLS_CHANGED_MAX_DELAY_MS` so a server that never stops notifying
   * still gets refreshed at a bounded rate instead of being starved forever.
   */
  private scheduleToolsRefresh(name: string): void {
    const connection = this.connections.get(name)
    if (!connection || connection.status !== 'connected') return

    if (connection.toolsRefreshInFlight) {
      // Don't drop a change that landed during the round trip — queue one more.
      connection.toolsRefreshQueued = true
      return
    }
    if (connection.toolsRefreshTimer) return // already scheduled in this window

    const elapsed = Date.now() - (connection.toolsRefreshedAt ?? 0)
    const delay = Math.min(
      TOOLS_CHANGED_DEBOUNCE_MS,
      Math.max(0, TOOLS_CHANGED_MAX_DELAY_MS - elapsed),
    )

    const timer = setTimeout(() => {
      connection.toolsRefreshTimer = undefined
      void this.runToolsRefresh(name)
    }, delay)
    // Housekeeping only — it must not hold the CLI process open.
    timer.unref()
    connection.toolsRefreshTimer = timer
  }

  /** Run a coalesced refresh, then drain a notification that arrived mid-flight. */
  private async runToolsRefresh(name: string): Promise<void> {
    const connection = this.connections.get(name)
    if (!connection || connection.status !== 'connected') return

    connection.toolsRefreshedAt = Date.now()
    connection.toolsRefreshInFlight = true
    try {
      await this.applyToolsChanged(name)
    } catch {
      // A refresh against a server that has gone away must not surface as an
      // unhandled rejection out of a timer callback — record the lost
      // connection instead.
      const current = this.connections.get(name)
      if (current) this.markIfTransportLost(name, current)
    } finally {
      // Re-read: the server may have been disconnected while we were awaiting.
      const current = this.connections.get(name)
      if (current) {
        current.toolsRefreshInFlight = false
        if (current.toolsRefreshQueued) {
          current.toolsRefreshQueued = false
          this.scheduleToolsRefresh(name)
        }
      }
    }
  }

  /** Drop any pending refresh state for a connection being torn down. */
  private cancelToolsRefresh(connection: ActiveConnection): void {
    if (connection.toolsRefreshTimer) clearTimeout(connection.toolsRefreshTimer)
    connection.toolsRefreshTimer = undefined
    connection.toolsRefreshQueued = false
    connection.toolsRefreshInFlight = false
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
          await connection.transport.close()
        } catch {
          /* ok */
        }
        // A pending refresh timer would outlive this connection and re-fire
        // against the replacement registered under the same name.
        this.cancelToolsRefresh(connection)
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

    const transport: StdioTransport | HttpTransport = config.url
      ? new HttpTransport(undefined, config.request_timeout_ms)
      : new StdioTransport(config.request_timeout_ms)
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
      await this.withConnectTimeout(config.name, async () => {
        // Start the transport (transport-specific), then perform the handshake.
        if (transport instanceof HttpTransport) {
          await transport.start(config.url ?? '', config.headers, config.env)
        } else {
          await transport.start(config.command ?? '', config.args ?? [], config.env)
        }
        const initResult: InitializeResult = await protocol.initialize()

        connection.status = 'connected'
        connection.serverInfo = initResult.serverInfo

        // Wire tools-changed notification (coalesced — see scheduleToolsRefresh)
        protocol.on('tools-changed', () => {
          this.scheduleToolsRefresh(config.name)
        })

        // Discover tools
        if (initResult.capabilities.tools) {
          connection.tools = await protocol.listTools()
        }
      })
    } catch (err) {
      connection.status = 'error'
      connection.error = String(err)
      try {
        await transport.close()
      } catch {
        // Best-effort cleanup on a failed connect
      }
      throw err
    }
  }

  /** Race the connect handshake against a timeout so a hung server fails fast. */
  private async withConnectTimeout<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const timeoutMs = connectTimeoutMs()
    let timer: ReturnType<typeof setTimeout> | null = null
    // Swallow a late rejection: if the timeout wins, transport.close() in the
    // caller's catch makes fn()'s pending request reject after we've moved on.
    const work = fn()
    work.catch(() => {})
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`MCP connect timed out for "${name}" after ${timeoutMs}ms`)),
            timeoutMs,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Disconnect an MCP server and return the names of its registered tools
   * so the caller can unregister them from the central tool registry.
   */
  disconnect(name: string): string[] {
    const conn = this.connections.get(name)
    if (!conn) return []

    this.cancelToolsRefresh(conn)
    try {
      // disconnect() is synchronous and returns the removed names, so this close
      // is best-effort and must not be awaited.
      void conn.transport.close()
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
      const conn = this.connections.get(name)
      if (conn) this.cancelToolsRefresh(conn)
      try {
        await conn?.transport.close()
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
        url: conn.config.url,
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
        url: conn.config.url,
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
      this.markIfTransportLost(serverName, conn)
      return {
        content: [{ type: 'text', text: t('errors.mcp_tool_error', { error: String(err) }) }],
        isError: true,
      }
    }
  }

  /**
   * Downgrade a connection whose transport has gone away.
   *
   * A tool call can fail because the *tool* failed or because the server did, and
   * only the transport can tell those apart: a closed transport answers nothing
   * from now on. Without this the connection stays 'connected' and `/mcp` keeps
   * showing green for a server that is gone.
   */
  private markIfTransportLost(name: string, connection: ActiveConnection): void {
    if (connection.transport.isConnected()) return
    if (connection.status === 'error') return

    connection.status = 'error'
    connection.error = 'Connection lost — the transport is no longer connected'
    this.emit('disconnected', name, connection.error)
  }
}
