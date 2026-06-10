import type {
  InitializeResult,
  ToolDefinition,
  ToolCallResult,
  ResourceDefinition,
  ResourceReadResult,
} from './types'
import { StdioTransport } from './transport'

const MCP_VERSION = '2024-11-05'

/**
 * MCP protocol layer — implements the initialize/tools/resources
 * lifecycle on top of a StdioTransport.
 */
export class McpProtocol {
  private serverCapabilities: { tools?: { listChanged?: boolean }; resources?: { subscribe?: boolean; listChanged?: boolean } } = {}

  constructor(private transport: StdioTransport) {}

  async initialize(serverCommand: string, serverArgs: string[], env?: Record<string, string>): Promise<InitializeResult> {
    // Start transport
    await this.transport.start(serverCommand, serverArgs, env)

    // Send initialize request
    const result = await this.transport.sendRequest('initialize', {
      protocolVersion: MCP_VERSION,
      capabilities: {
        tools: {},
        resources: {},
      },
      clientInfo: {
        name: 'Mipham Code',
        version: '0.2.0',
      },
    }) as InitializeResult

    // Send initialized notification
    this.transport.sendNotification('notifications/initialized')

    this.serverCapabilities = result.capabilities

    return result
  }

  async listTools(): Promise<ToolDefinition[]> {
    const result = await this.transport.sendRequest('tools/list') as { tools: ToolDefinition[] }
    return result.tools || []
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallResult> {
    const result = await this.transport.sendRequest('tools/call', {
      name,
      arguments: args || {},
    }) as ToolCallResult
    return result
  }

  async listResources(): Promise<ResourceDefinition[]> {
    if (!this.serverCapabilities.resources) {
      return []
    }
    const result = await this.transport.sendRequest('resources/list') as { resources: ResourceDefinition[] }
    return result.resources || []
  }

  async readResource(uri: string): Promise<ResourceReadResult> {
    const result = await this.transport.sendRequest('resources/read', { uri }) as ResourceReadResult
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
