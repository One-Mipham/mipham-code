import { spawn, type ChildProcess } from 'node:child_process'
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './types'

type NotificationHandler = (notification: JsonRpcNotification) => void

const REQUEST_TIMEOUT_MS = 30_000

// ── Environment variable security: block sensitive vars from MCP subprocess ──
//
// By default, MCP servers receive a sanitised copy of the parent environment.
// Sensitive values (API keys, tokens, secrets, cloud credentials) are stripped
// to prevent data exfiltration by third-party MCP plugins.
//
// The `env` parameter on `start()` allows explicit overrides — use it to
// intentionally pass specific values to a trusted MCP server.
const SENSITIVE_ENV_PATTERNS = [
  /_API_KEY$/i, // ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.
  /_SECRET$/i, // STRIPE_SECRET, etc.
  /_TOKEN$/i, // GITHUB_TOKEN, NPM_TOKEN, etc.
  /_PASSWORD$/i, // DB_PASSWORD, etc.
  /_CREDENTIALS?$/i, // GOOGLE_APPLICATION_CREDENTIALS, etc.
  /^AWS_/, // AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, etc.
  /^GCLOUD_/, // GCP credentials
  /^AZURE_/, // Azure credentials
  /^DOCKER_/, // DOCKER_TOKEN, DOCKER_PASSWORD
]

/**
 * Build a sanitised environment for MCP subprocesses.
 * Strips sensitive vars; allows explicit overrides via `extra`.
 */
function buildProcEnv(extra?: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env as Record<string, string>)) {
    if (value === undefined) continue
    if (SENSITIVE_ENV_PATTERNS.some((p) => p.test(key))) continue
    sanitized[key] = value
  }

  // Explicit overrides take precedence (for intentionally shared secrets)
  if (extra) {
    Object.assign(sanitized, extra)
  }

  return sanitized
}

/**
 * MCP stdio transport — spawns a subprocess and communicates via
 * newline-delimited JSON-RPC 2.0 messages on stdin/stdout.
 *
 * Uses Node.js child_process for portability across Bun and Node runtimes.
 */
export class StdioTransport {
  private proc: ChildProcess | null = null
  private msgId = 0
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private notificationHandlers: NotificationHandler[] = []
  private buffer = ''
  private closed = false

  async start(command: string, args: string[], env?: Record<string, string>): Promise<void> {
    this.closed = false

    const procEnv = buildProcEnv(env)

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: procEnv,
      })

      child.on('error', (err) => {
        this.closed = true
        reject(err)
      })

      child.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString()
        const lines = this.buffer.split('\n')
        this.buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue

          try {
            const msg = JSON.parse(trimmed)

            // Check if it's a response (has id and result/error)
            if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
              const response = msg as JsonRpcResponse
              const entry = this.pending.get(response.id)
              if (entry) {
                clearTimeout(entry.timer)
                this.pending.delete(response.id)
                if (response.error) {
                  entry.reject(
                    new Error(`MCP error ${response.error.code}: ${response.error.message}`),
                  )
                } else {
                  entry.resolve(response.result)
                }
              }
            } else if (msg.method && msg.id === undefined) {
              // Notification — no id field
              for (const handler of this.notificationHandlers) {
                handler(msg as JsonRpcNotification)
              }
            }
          } catch {
            // Skip unparseable lines
          }
        }
      })

      child.on('close', () => {
        this.closed = true
        // Reject any remaining pending requests
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer)
          entry.reject(new Error('Transport closed'))
        }
        this.pending.clear()
      })

      this.proc = child
      resolve()
    })
  }

  async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.proc || this.closed) {
      throw new Error('Transport not connected')
    }

    const id = ++this.msgId
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params ? { params } : {}),
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request timeout: ${method} (${REQUEST_TIMEOUT_MS}ms)`))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })

      // Write to stdin
      this.proc!.stdin!.write(JSON.stringify(request) + '\n')
    })
  }

  sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.proc || this.closed) return

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params ? { params } : {}),
    }

    this.proc.stdin!.write(JSON.stringify(notification) + '\n')
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler)
  }

  async close(): Promise<void> {
    this.closed = true

    // Reject all pending requests
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Transport closed'))
    }
    this.pending.clear()

    if (this.proc) {
      try {
        this.proc.stdin?.end()
      } catch {
        /* ignore */
      }
      this.proc.kill()
      this.proc = null
    }
  }

  isConnected(): boolean {
    return this.proc !== null && !this.closed
  }
}
