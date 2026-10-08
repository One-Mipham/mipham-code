import type {
  InitializeResult,
  ToolDefinition,
  ToolCallResult,
  ResourceDefinition,
  ResourceReadResult,
} from './types'
import type { Transport } from './transport'
import { createT } from '../i18n-core/t'
import enUS from '../i18n-core/locales/en-US.json'
import zhCN from '../i18n-core/locales/zh-CN.json'
import type { TranslationMap } from '../i18n-core/types'

const bundles: Record<string, TranslationMap> = {
  'en-US': enUS as TranslationMap,
  'zh-CN': zhCN as TranslationMap,
}
const t = createT(bundles['en-US'] || (enUS as TranslationMap), enUS as TranslationMap)

/**
 * Protocol revisions this client is prepared to speak, newest first.
 *
 * Only revisions whose wire behaviour the code below actually implements belong
 * here — offering a revision is a claim that its messages will be understood,
 * and a server that takes us at our word would then send shapes we cannot parse.
 * The list exists so that adopting a revision is an edit to a value rather than
 * a change to the handshake, and so the server's answer has something to be
 * checked against.
 */
export const MCP_SUPPORTED_VERSIONS: readonly string[] = ['2024-11-05']

/**
 * The revision to offer in `initialize`.
 *
 * `MCP_PROTOCOL_NEGOTIATION=legacy` pins the oldest supported revision. The
 * handshake used to send one hardcoded literal with no way to ask for anything
 * else, so a server that answers an unrecognized revision by failing the
 * connection — rather than by replying with the one it speaks — was simply
 * unreachable.
 *
 * An unset or unrecognized value offers the newest.
 */
export function offerVersion(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MCP_PROTOCOL_NEGOTIATION === 'legacy') {
    return MCP_SUPPORTED_VERSIONS[MCP_SUPPORTED_VERSIONS.length - 1]!
  }
  return MCP_SUPPORTED_VERSIONS[0]!
}

/**
 * MCP protocol layer — implements the initialize/tools/resources
 * lifecycle on top of a StdioTransport.
 */
export class McpProtocol {
  private serverCapabilities: {
    tools?: { listChanged?: boolean }
    resources?: { subscribe?: boolean; listChanged?: boolean }
  } = {}
  private handlers = new Map<string, Array<(...args: any[]) => void>>()
  /** The revision the last `initialize` agreed on, or null before one ran. */
  private agreedVersion: string | null = null

  constructor(private transport: Transport) {}

  /**
   * The protocol revision this connection settled on.
   *
   * The server's answer, not the one we offered: `initialize` replies with the
   * revision it will actually speak, which may be older than the offer. Recorded
   * because the field used to be received and dropped — a server that answered
   * with a revision this client never implemented looked exactly like one that
   * agreed.
   */
  get protocolVersion(): string | null {
    return this.agreedVersion
  }

  on(event: string, handler: (...args: any[]) => void): void {
    const list = this.handlers.get(event) || []
    list.push(handler)
    this.handlers.set(event, list)
  }

  private emit(event: string, ...args: any[]): void {
    const list = this.handlers.get(event) || []
    for (const h of list) h(...args)
  }

  async initialize(): Promise<InitializeResult> {
    // Transport must already be started by the caller (McpClient.connect).
    // Send initialize request
    const result = (await this.transport.sendRequest('initialize', {
      protocolVersion: offerVersion(),
      capabilities: {
        tools: {},
        resources: {},
      },
      clientInfo: {
        name: 'Mipham Code',
        version: '0.2.0',
      },
    })) as InitializeResult

    this.agreedVersion = result.protocolVersion ?? null
    if (this.agreedVersion && !MCP_SUPPORTED_VERSIONS.includes(this.agreedVersion)) {
      // Not a fatal error: the base lifecycle is stable across revisions, so the
      // connection usually still works. Say so rather than let an unexpected
      // revision look like an agreement — if messages then misbehave, this line
      // is the first thing that explains why.
      console.error(
        t('errors.mcp_protocol_version_mismatch', {
          version: this.agreedVersion,
          supported: MCP_SUPPORTED_VERSIONS.join(', '),
        }),
      )
    }

    // Send initialized notification
    this.transport.sendNotification('notifications/initialized')

    // Register notification handler for tools/list_changed
    this.transport.onNotification((notification) => {
      if (notification.method === 'notifications/tools/list_changed') {
        this.emit('tools-changed', notification.params)
      }
    })

    this.serverCapabilities = result.capabilities

    return result
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = (await this.transport.sendRequest('tools/list')) as { tools: ToolDefinition[] }
    return result.tools || []
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallResult> {
    const result = (await this.transport.sendRequest('tools/call', {
      name,
      arguments: args || {},
    })) as ToolCallResult
    return result
  }

  async listResources(): Promise<ResourceDefinition[]> {
    if (!this.serverCapabilities.resources) {
      return []
    }
    const result = (await this.transport.sendRequest('resources/list')) as {
      resources: ResourceDefinition[]
    }
    return result.resources || []
  }

  async readResource(uri: string): Promise<ResourceReadResult> {
    const result = (await this.transport.sendRequest('resources/read', {
      uri,
    })) as ResourceReadResult
    return result
  }

  onNotification(handler: (method: string, params?: Record<string, unknown>) => void): void {
    this.transport.onNotification((notification) => {
      handler(notification.method, notification.params)
    })
  }

  hasTools(): boolean {
    return !!this.serverCapabilities.tools
  }

  hasResources(): boolean {
    return !!this.serverCapabilities.resources
  }

  getCapabilities() {
    return { ...this.serverCapabilities }
  }

  async close(): Promise<void> {
    await this.transport.close()
  }
}
