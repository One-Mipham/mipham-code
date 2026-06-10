// ── JSON-RPC 2.0 ──

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

// ── MCP Initialize ──

export interface InitializeRequest {
  protocolVersion: string
  capabilities: ClientCapabilities
  clientInfo: { name: string; version: string }
}

export interface ClientCapabilities {
  tools?: Record<string, unknown>
  resources?: Record<string, unknown>
}

export interface InitializeResult {
  protocolVersion: string
  capabilities: ServerCapabilities
  serverInfo: { name: string; version: string }
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean }
  resources?: { subscribe?: boolean; listChanged?: boolean }
}

// ── MCP Tools ──

export interface ToolDefinition {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

export interface ToolCallParams {
  name: string
  arguments?: Record<string, unknown>
}

export interface ToolCallContent {
  type: 'text' | 'image' | 'resource'
  text?: string
  data?: string
  mimeType?: string
}

export interface ToolCallResult {
  content: ToolCallContent[]
  isError?: boolean
}

// ── MCP Resources ──

export interface ResourceDefinition {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface ResourceReadResult {
  contents: Array<{
    uri: string
    mimeType?: string
    text?: string
    blob?: string
  }>
}

// ── Connection State ──

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ConnectionInfo {
  config: { name: string; command: string; args: string[] }
  status: ConnectionStatus
  tools: ToolDefinition[]
  error?: string
  serverInfo?: { name: string; version: string }
}
