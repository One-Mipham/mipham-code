// apps/cli/src/daemon/remote-engine.ts — Phase 2 Task 6: Remote Engine
//
// RemoteEngine is a WebSocket-based substitute for the local QueryEngine.
// It exposes the same `process(prompt, signal)` async generator interface
// so the TUI can consume it identically when running in `mipham attach` mode.
//
// Architecture:
//   RemoteEngine
//     owns WebSocket connection to daemon
//     converts ServerMessage stream → StreamChunk stream
//     bridges event-driven WS to async generator via queue + resolver
//
// Usage:
//   const engine = new RemoteEngine({ sessionId, port, token })
//   for await (const chunk of engine.process('fix the bug')) {
//     // same StreamChunk as local QueryEngine
//   }
//   engine.close()

import type {
  ClientPromptMessage,
  ClientInterruptMessage,
  ServerMessage,
} from './attach-protocol'
import type { StreamChunk } from '../shared/types'

// ── Public API ───────────────────────────────────────────────────────────────

export interface RemoteEngineOptions {
  /** Daemon session ID — the session to connect to. */
  sessionId: string
  /** Daemon HTTP/WS port (default 45671). */
  port: number
  /** Auth token (for future non-localhost use; localhost bypasses auth). */
  token: string
}

/**
 * WebSocket-based substitute for the local QueryEngine.
 *
 * Connects to a running daemon's WebSocket endpoint and streams prompt
 * responses as StreamChunk objects — the same interface the TUI already
 * consumes from the local engine.
 */
export class RemoteEngine {
  private sessionId: string
  private port: number
  private token: string
  private ws: WebSocket | null = null

  /** Queued chunks not yet consumed by the async generator. */
  private chunkQueue: StreamChunk[] = []

  /** Resolver for the currently-waiting generator yield. */
  private resolveNext: ((chunk: StreamChunk) => void) | null = null
  private rejectNext: ((reason: Error) => void) | null = null

  /** Whether this engine has been explicitly closed. */
  private closed = false

  constructor(options: RemoteEngineOptions) {
    this.sessionId = options.sessionId
    this.port = options.port
    this.token = options.token
  }

  // ── Connection Management ───────────────────────────────────────────────

  /**
   * Ensure a WebSocket connection to the daemon exists.
   * Creates one lazily on the first process() call.
   */
  private ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve()
    }

    if (this.ws) {
      // Stale socket — clean up before reconnecting
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      try {
        this.ws.close()
      } catch {
        // Ignore close errors on stale socket
      }
      this.ws = null
    }

    const url = `ws://127.0.0.1:${this.port}/api/v1/sessions/${this.sessionId}/stream`

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url)
      this.ws = ws

      ws.onopen = () => {
        resolve()
      }

      ws.onmessage = (event: MessageEvent<string>) => {
        this.onMessage(event.data)
      }

      ws.onclose = () => {
        // Only signal to the generator if there is an active wait.
        if (this.resolveNext) {
          const doneChunk: StreamChunk = { type: 'stop' }
          this.resolveNext(doneChunk)
          this.resolveNext = null
        }
      }

      ws.onerror = () => {
        reject(new Error(`Failed to connect to daemon at 127.0.0.1:${this.port}`))
      }
    })
  }

  // ── Prompt Processing (async generator) ──────────────────────────────────

  /**
   * Process a user prompt through the remote daemon session.
   *
   * Internally sends a `prompt` message over the WebSocket and yields
   * StreamChunk objects as they arrive from the daemon. The async generator
   * stops naturally when a `done` or `error` message is received.
   *
   * @param prompt  The user's text prompt to send.
   * @param signal  Optional AbortSignal — aborts the prompt (sends interrupt).
   */
  async *process(prompt: string, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    if (this.closed) {
      yield { type: 'error', error: 'RemoteEngine is closed' }
      return
    }

    // Check signal before connecting
    if (signal?.aborted) {
      yield { type: 'stop' }
      return
    }

    await this.ensureConnected()

    // Reset per-prompt state
    this.chunkQueue = []
    this.resolveNext = null
    this.rejectNext = null

    // Send the prompt
    const promptMsg: ClientPromptMessage = {
      type: 'prompt',
      sessionId: this.sessionId,
      prompt,
    }
    this.ws!.send(JSON.stringify(promptMsg))

    // ── Abort signal → interrupt message ──────────────────────────────
    const onAbort = () => {
      const interruptMsg: ClientInterruptMessage = {
        type: 'interrupt',
        sessionId: this.sessionId,
      }
      try {
        this.ws!.send(JSON.stringify(interruptMsg))
      } catch {
        // WebSocket may already be closing — ignore
      }
      // Reject any pending wait so the generator stops cleanly
      if (this.rejectNext) {
        this.rejectNext(new DOMException('Aborted', 'AbortError'))
        this.rejectNext = null
        this.resolveNext = null
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      let running = true

      while (running) {
        // Drain any buffered chunks from the queue first
        while (this.chunkQueue.length > 0) {
          const chunk = this.chunkQueue.shift()!
          running = this.yieldAndCheck(chunk)
          yield chunk
          if (!running) return
        }

        if (!running) break

        // Wait for the next chunk from the WebSocket
        const chunk = await new Promise<StreamChunk>((resolve, reject) => {
          this.resolveNext = resolve
          this.rejectNext = reject
        })

        running = this.yieldAndCheck(chunk)
        yield chunk
        if (!running) return
      }
    } catch (err) {
      if (signal?.aborted) {
        yield { type: 'stop' }
      } else {
        yield {
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      this.resolveNext = null
      this.rejectNext = null
    }
  }

  // ── Stub methods for TUI compatibility ───────────────────────────────────
  //
  // In remote attach mode, the daemon manages providers, agents, permissions,
  // and context. These stubs satisfy the TUI's engine interface without
  // introducing daemon dependencies into the UI layer.
  //
  // Slash commands may call any of these; we return safe defaults.

  /** No-op: provider switching is managed by the daemon session. */
  switchProvider(_providerId: string, _modelId?: string): void {}

  /** Remote mode has no local agent registry. */
  getAgentRegistry(): undefined {
    return undefined
  }

  /** No-op: agents run on the daemon. */
  setAgentRegistry(_reg: unknown): void {}

  /** Returns a stub context object so slash commands and auto-save don't crash. */
  getContext(): {
    saveCheckpoint(_label: string): void
    clear(): void
    getMessages(): Array<{ role: string; content: string }>
    getEstimatedTokens(): number
  } {
    return {
      saveCheckpoint: (_label: string) => {
        // Remote mode: checkpoints are managed by the daemon
      },
      clear: () => {
        // Remote mode: session history lives on the daemon
      },
      getMessages: () => [],
      getEstimatedTokens: () => 0,
    }
  }

  /** Returns a stub permission object so slash commands don't crash. */
  getPermission(): { setMode(_mode: string): void } {
    return {
      setMode: (_mode: string) => {
        // Remote mode: permissions are managed by the daemon
      },
    }
  }

  /** Returns an empty tool set — tools run on the daemon. */
  getTools(): Map<string, unknown> {
    return new Map()
  }

  /** Remote mode has no local rule engine. */
  getRuleEngine(): undefined {
    return undefined
  }

  /** Remote mode has no local pattern analyzer. */
  getPatternAnalyzer(): undefined {
    return undefined
  }

  /** Remote mode has no local effectiveness tracker. */
  getEffectivenessTracker(): undefined {
    return undefined
  }

  /** Remote mode has no local goal state. */
  getGoalState(): { goal: undefined; decompose: false; subtasks: never[] } {
    return { goal: undefined, decompose: false, subtasks: [] }
  }

  /** No-op: goals are managed by the daemon session. */
  setGoal(_goal: string, _opts?: unknown): void {}

  /** Remote mode has no local usage tracker. */
  getUsageTracker(): { getStats(): Record<string, number> } {
    return { getStats: () => ({}) }
  }

  /** Remote mode has no local agent view manager. */
  getAgentViewManager(): undefined {
    return undefined
  }

  /** Returns a stub registry so slash commands don't crash. */
  getRegistry(): { getProvider(_id: string): unknown; getProviders(): unknown[] } {
    return {
      getProvider: (_id: string) => undefined,
      getProviders: () => [],
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  /** Close the WebSocket connection and release resources. */
  close(): void {
    this.closed = true
    if (this.ws) {
      // Reject any pending wait
      if (this.rejectNext) {
        this.rejectNext(new Error('RemoteEngine closed'))
        this.rejectNext = null
        this.resolveNext = null
      }
      try {
        this.ws.close()
      } catch {
        // Ignore close errors
      }
      this.ws = null
    }
  }

  // ── Internal Helpers ─────────────────────────────────────────────────────

  /**
   * Process an incoming raw WebSocket message (JSON string).
   * Parses it as a ServerMessage, maps it to a StreamChunk, and either
   * resolves the pending generator wait or enqueues it.
   */
  private onMessage(raw: string): void {
    let msg: ServerMessage
    try {
      msg = JSON.parse(raw) as ServerMessage
    } catch {
      return
    }

    const chunk = this.mapMessageToChunk(msg)
    if (!chunk) return

    if (this.resolveNext) {
      this.resolveNext(chunk)
      this.resolveNext = null
    } else {
      this.chunkQueue.push(chunk)
    }
  }

  /**
   * Map a ServerMessage from the daemon to a StreamChunk.
   * Returns null for message types that should be silently consumed
   * (e.g., session_state which is only informative for attach).
   */
  private mapMessageToChunk(msg: ServerMessage): StreamChunk | null {
    switch (msg.type) {
      case 'text': {
        return { type: 'text', content: msg.content }
      }

      case 'tool_use': {
        return {
          type: 'tool_use',
          toolUse: {
            type: 'tool_use' as const,
            name: msg.toolName,
            input: msg.toolInput,
            id: msg.toolId,
          },
        }
      }

      case 'tool_result': {
        return {
          type: 'tool_result',
          tool_use_id: msg.toolId,
          content: msg.content,
        }
      }

      case 'usage': {
        return {
          type: 'usage',
          inputTokens: msg.inputTokens,
          outputTokens: msg.outputTokens,
        }
      }

      case 'task_notification': {
        return {
          type: 'task_notification',
          taskNotification: {
            taskId: msg.taskId,
            status: msg.status as 'started' | 'completed' | 'failed',
            description: '',
          },
        }
      }

      case 'done': {
        return { type: 'stop' }
      }

      case 'error': {
        return { type: 'error', error: msg.message }
      }

      // session_state is an informational message sent when a client
      // first attaches. It is not part of the prompt stream.
      case 'session_state':
        return null

      default:
        return null
    }
  }

  /**
   * Check whether the stream should continue after yielding a chunk.
   * Returns `false` for terminal chunk types (stop, error).
   */
  private yieldAndCheck(chunk: StreamChunk): boolean {
    if (chunk.type === 'stop' || chunk.type === 'error') {
      return false
    }
    return true
  }
}
