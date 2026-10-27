import { spawn, type ChildProcess } from 'node:child_process'
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './types'

export type NotificationHandler = (notification: JsonRpcNotification) => void

/**
 * Common transport contract shared by stdio and HTTP transports.
 *
 * `McpProtocol` depends on this interface (not a concrete transport), so it
 * can speak JSON-RPC 2.0 over either a spawned subprocess or an HTTP endpoint.
 * Transport startup is transport-specific and intentionally NOT part of this
 * interface — callers invoke the concrete `start(...)` before use.
 */
export interface Transport {
  sendRequest(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>
  sendNotification(method: string, params?: Record<string, unknown>): void
  onNotification(handler: NotificationHandler): void
  close(): Promise<void>
  isConnected(): boolean
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/**
 * How long a stdio MCP server gets to exit on its own after its stdin is closed,
 * before we kill it (296-048).
 *
 * Closing stdin **is** the protocol's shutdown signal — a well-behaved server
 * sees EOF, flushes, and exits. Killing it in the same tick gives it no chance
 * to do that; on Windows the kill also left the server's own children running.
 */
export const MCP_SHUTDOWN_GRACE_MS = 300

/** Resolve when `proc` exits, or after `ms` — whichever comes first. */
function waitForExit(proc: ChildProcess, ms: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(onExit, ms)
    proc.once('exit', onExit)
  })
}

/**
 * Terminate the server **and its descendants** once the grace period expired.
 *
 * The tree half is Windows-only, and deliberately so: Windows gives us no
 * process group to signal, so `taskkill /T` is the only way to reach the
 * server's own children. On POSIX we do **not** spawn MCP servers detached, so
 * the child shares our process group and has no group of its own —
 * `process.kill(-pid)` would be ESRCH, and making it a group leader would let
 * servers outlive the CLI, a worse bug than the one being fixed. There, the
 * grace period above *is* the fix; killing the direct child is what we always did.
 */
function killProcessTree(proc: ChildProcess): void {
  const pid = proc.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* fall through to the direct kill */
    }
  }
  try {
    proc.kill()
  } catch {
    /* already gone */
  }
}

/** Shared timeout error for both stdio and HTTP transports. */
export function requestTimeoutError(method: string, ms: number): Error {
  return new Error(`MCP request timeout: ${method} (${ms}ms)`)
}

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
export class StdioTransport implements Transport {
  constructor(
    private requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    /** Seam for tests: how long `close()` waits for a self-exit before killing. */
    private shutdownGraceMs = MCP_SHUTDOWN_GRACE_MS,
  ) {}
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

  async sendRequest(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.proc || this.closed) {
      throw new Error('Transport not connected')
    }
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    const id = ++this.msgId
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params ? { params } : {}),
    }

    return new Promise((resolve, reject) => {
      // Cancellation has to reach the request itself: the caller's turn-level
      // signal used to stop at the tool boundary, so a server that never
      // answered held the turn until the 60s request timeout. Clearing the
      // timer and deleting the pending entry keeps that timer from firing a
      // second rejection on an already-settled promise.
      const onAbort = (): void => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort)

      const timer = setTimeout(() => {
        this.pending.delete(id)
        cleanup()
        reject(requestTimeoutError(method, this.requestTimeoutMs))
      }, this.requestTimeoutMs)

      this.pending.set(id, {
        resolve: (v) => {
          cleanup()
          resolve(v)
        },
        reject: (e) => {
          cleanup()
          reject(e)
        },
        timer,
      })

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

    const proc = this.proc
    this.proc = null
    if (!proc) return

    // stdin EOF is the shutdown signal. Wait for the server to take it; only a
    // server still running after the grace period gets killed (296-048).
    try {
      proc.stdin?.end()
    } catch {
      /* ignore */
    }
    await waitForExit(proc, this.shutdownGraceMs)
    if (proc.exitCode === null && proc.signalCode === null) {
      killProcessTree(proc)
    }
  }

  isConnected(): boolean {
    return this.proc !== null && !this.closed
  }
}
