import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification, JsonRpcError } from './types'
import type { Transport, NotificationHandler } from './transport'
import { DEFAULT_REQUEST_TIMEOUT_MS, requestTimeoutError } from './transport'

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

/**
 * A non-2xx HTTP answer from an MCP server.
 *
 * Carries `needsAuth` — the server said our credentials are missing or too
 * narrow. Callers turn that into "re-authenticate", which a bare status code
 * cannot express: `403` also means "this tool is forbidden to you", and telling
 * the user to re-authenticate then sends them round a loop that cannot help.
 * The signal is the `WWW-Authenticate` challenge the server attaches
 * (RFC 6750/9728), which the transport used to discard.
 */
export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly needsAuth: boolean,
  ) {
    super(`MCP HTTP error ${status}: ${detail}`)
    this.name = 'McpHttpError'
  }
}

/**
 * Does this challenge say the token we sent was missing or insufficient?
 *
 * `insufficient_scope` is the RFC 6750 code for "authenticated, but not for
 * this"; a bare `Bearer` on a 401 means no usable token at all. A 403 whose
 * challenge carries neither is a flat refusal and gets no auth hint.
 */
export function challengeNeedsAuth(status: number, challenge: string): boolean {
  if (!challenge) return false
  if (status === 401) return /^bearer\b/i.test(challenge.trim())
  if (status === 403) return /insufficient_scope/i.test(challenge)
  return false
}

/**
 * Merge multiple SSE `data:` events into a single JSON-RPC result.
 *
 * A Streamable HTTP server may answer a tool call as an SSE stream of several
 * `data:` events, each carrying the same request id and a slice of the tool
 * result text (this is how Forge's `/mcp` streams progressive chunks). We
 * reassemble those slices so callers see one complete result.
 */
function parseSseResponse(
  body: string,
  onNotification?: (notification: JsonRpcNotification) => void,
): unknown {
  const messages: Array<{ id?: number; result?: unknown; error?: JsonRpcError }> = []

  for (const block of body.split(/\n\n/)) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice('data:'.length).trim()
      if (!payload) continue
      try {
        const message = JSON.parse(payload) as JsonRpcResponse & JsonRpcNotification
        // Server-initiated notifications (e.g. tools/list_changed) arrive on the
        // same stream as the response to the request in flight. They carry no id
        // and are not part of that response, so hand them off rather than letting
        // them count as a result — or as a chunk of one.
        if (message.method !== undefined && message.id === undefined) {
          onNotification?.(message as JsonRpcNotification)
          continue
        }
        messages.push(message)
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

  constructor(
    private fetchImpl: FetchFn = fetch as unknown as FetchFn,
    private requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  async start(
    url: string,
    headers?: Record<string, string>,
    env?: Record<string, string>,
  ): Promise<void> {
    this.url = url
    this.closed = false

    // Build base headers: explicit headers override, then auto-derive a
    // Bearer token from the env so the secret stays out of the config file.
    // MCP_ACCESS_TOKEN is what the OAuth flow produces (McpClient.connectOnce);
    // FORGE_API_KEY mirrors Forge's verify_api_key for a static deployment.
    // Before this, an OAuth-configured server got its token minted and dropped
    // into env where nothing read it: the request went out unauthenticated.
    const bearer = env?.MCP_ACCESS_TOKEN ?? env?.FORGE_API_KEY
    this.headers = {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
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
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)

    // Did an HTTP response come back at all? A rejected fetch or a timeout means
    // the endpoint is unreachable; an error *status* only means it said no.
    let reachable = false

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
        redirect: 'manual',
      })
      reachable = true

      if (!response.ok) {
        let detail = `HTTP ${response.status}`
        try {
          detail = JSON.stringify(await response.json())
        } catch {
          /* keep status-only detail */
        }
        // The challenge is the server telling us *how* to authenticate. Keep it
        // — dropping it leaves "403 {…}" as the only clue the user gets.
        const challenge = response.headers.get('www-authenticate') ?? ''
        const needsAuth = challengeNeedsAuth(response.status, challenge)
        if (challenge) detail += ` (WWW-Authenticate: ${challenge})`
        throw new McpHttpError(response.status, detail, needsAuth)
      }

      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('text/event-stream')) {
        return parseSseResponse(await response.text(), (n) => this.dispatchNotification(n))
      }

      const json = (await response.json()) as JsonRpcResponse
      if (json.error) {
        throw new Error(`MCP error ${json.error.code}: ${json.error.message}`)
      }
      return json.result
    } catch (err) {
      if (controller.signal.aborted) {
        // The endpoint never answered. Every later request would hang the same
        // way, so the transport reports itself disconnected — the same state a
        // stdio transport reaches when its process exits — until reconnect()
        // replaces it.
        this.closed = true
        throw requestTimeoutError(method, this.requestTimeoutMs)
      }
      if (!reachable) {
        this.closed = true
      }
      throw err
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
      redirect: 'manual',
    }).catch(() => {
      /* notifications are best-effort */
    })
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler)
  }

  /** Hand a server-initiated notification to every registered handler. */
  private dispatchNotification(notification: JsonRpcNotification): void {
    for (const handler of this.notificationHandlers) {
      handler(notification)
    }
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
