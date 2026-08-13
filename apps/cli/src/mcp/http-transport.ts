import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification, JsonRpcError } from './types'
import type { Transport, NotificationHandler } from './transport'

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

const REQUEST_TIMEOUT_MS = 60_000

/**
 * Merge multiple SSE `data:` events into a single JSON-RPC result.
 *
 * A Streamable HTTP server may answer a tool call as an SSE stream of several
 * `data:` events, each carrying the same request id and a slice of the tool
 * result text (this is how Forge's `/mcp` streams progressive chunks). We
 * reassemble those slices so callers see one complete result.
 */
function parseSseResponse(body: string): unknown {
  const messages: Array<{ id?: number; result?: unknown; error?: JsonRpcError }> = []

  for (const block of body.split(/\n\n/)) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice('data:'.length).trim()
      if (!payload) continue
      try {
        messages.push(JSON.parse(payload))
      } catch {
        // Skip unparseable event lines
      }
    }
  }

  if (messages.length === 0) {
    throw new Error('Empty SSE response')
  }

  // A single event → return its result (or throw its error) directly.
  if (messages.length === 1) {
    const message = messages[0]!
    if (message.error) {
      throw new Error(`MCP error ${message.error.code}: ${message.error.message}`)
    }
    return message.result
  }

  // Multiple events → chunked tool result; reassemble text content.
  const texts: string[] = []
  for (const message of messages) {
    if (message.error) {
      throw new Error(`MCP error ${message.error.code}: ${message.error.message}`)
    }
    const content = (message.result as { content?: Array<{ type: string; text?: string }> })
      ?.content
    if (content) {
      for (const item of content) {
        if (item.type === 'text' && item.text) texts.push(item.text)
      }
    }
  }

  return { content: [{ type: 'text', text: texts.join('') }], isError: false }
}

/**
 * MCP Streamable HTTP transport — speaks JSON-RPC 2.0 to an HTTP endpoint
 * (e.g. Forge's `POST /mcp`), returning plain JSON or reassembled SSE streams.
 *
 * Startup is via `start(url, headers?, env?)`; the `Transport` interface
 * methods match `StdioTransport` so `McpProtocol` can use either.
 */
export class HttpTransport implements Transport {
  private url: string | null = null
  private headers: Record<string, string> = {}
  private msgId = 0
  private closed = false
  private notificationHandlers: NotificationHandler[] = []

  constructor(private fetchImpl: FetchFn = fetch as unknown as FetchFn) {}

  async start(
    url: string,
    headers?: Record<string, string>,
    env?: Record<string, string>,
  ): Promise<void> {
    this.url = url
    this.closed = false

    // Build base headers: explicit headers override, then auto-derive a
    // Bearer token from FORGE_API_KEY (mirrors Forge's verify_api_key) so the
    // secret stays in env rather than inline in config.
    this.headers = {
      ...(env?.FORGE_API_KEY ? { Authorization: `Bearer ${env.FORGE_API_KEY}` } : {}),
      ...(headers ?? {}),
    }
  }

  async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.url || this.closed) {
      throw new Error('Transport not connected')
    }

    const id = ++this.msgId
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params ? { params } : {}),
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...this.headers,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      })

      if (!response.ok) {
        let detail = `HTTP ${response.status}`
        try {
          detail = JSON.stringify(await response.json())
        } catch {
          /* keep status-only detail */
        }
        throw new Error(`MCP HTTP error ${response.status}: ${detail}`)
      }

      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('text/event-stream')) {
        return parseSseResponse(await response.text())
      }

      const json = (await response.json()) as JsonRpcResponse
      if (json.error) {
        throw new Error(`MCP error ${json.error.code}: ${json.error.message}`)
      }
      return json.result
    } finally {
      clearTimeout(timer)
    }
  }

  sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.url || this.closed) return

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    }

    // Fire-and-forget: do not await the response.
    void this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...this.headers,
      },
      body: JSON.stringify(notification),
    }).catch(() => {
      /* notifications are best-effort */
    })
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler)
  }

  async close(): Promise<void> {
    this.closed = true
    this.url = null
    this.notificationHandlers = []
  }

  isConnected(): boolean {
    return this.url !== null && !this.closed
  }
}
