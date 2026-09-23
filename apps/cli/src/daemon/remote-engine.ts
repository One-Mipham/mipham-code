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
  ClientSetModeMessage,
  ServerMessage,
} from './attach-protocol'
import { ALL_MODES } from '../core/permission-config'
import type { PermissionMode, StreamChunk } from '../shared/types'

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

  /** In-flight connection attempt. See `ensureConnected()`. */
  private connecting: Promise<void> | null = null

  // ── Permission mode (the gate lives on the daemon) ───────────────────────
  //
  // Two values, and the difference between them is the whole contract:
  //
  // - `modeChosen` — the mode **this client's user** picked on this attach. Set by a
  //   keypress (so the footer advances immediately — `cyclePermissionMode` computes the
  //   next slot from `getMode()`'s read-back, and a `getMode` that only reported confirmed
  //   values would freeze the wheel), then overwritten by the daemon's **answer**, because
  //   org level `permissionRestrictions` silently rewrite a request and the daemon is the
  //   only side that can see the clamp. A non-null value is a standing instruction and gets
  //   re-asserted before every prompt. A connect snapshot is not an answer (see
  //   `absorbMode`): it predates anything this client sent and must not retract it.
  // - `modeConfirmed` — what the daemon said is in effect, from a `mode` frame or an
  //   attach snapshot. **Display only, never asserted**: it is how a client that has not
  //   picked anything learns the session's mode, and re-sending it would let a bystander
  //   push its own guess over an operator's `MIPHAM_DAEMON_PERMISSION` — a silent override
  //   by a client that never expressed an intent.
  private modeChosen: PermissionMode | null = null
  private modeConfirmed: PermissionMode | null = null

  /** Viewers of the confirmed mode (the TUI footer). See `onPermissionModeChange`. */
  private readonly modeListeners = new Set<(mode: PermissionMode) => void>()

  /**
   * One stable object — **not** a fresh closure per `getPermission()` call.
   *
   * `app.tsx` calls `getPermission()` per keypress (`cyclePermissionMode(engine.getPermission(), …)`
   * and the initial `useState`), so a per-call object-throws away everything it was told:
   * the mode read back is a brand-new `'default'` and nothing is ever sent to the daemon.
   */
  private readonly permissionFacade = {
    setMode: (mode: PermissionMode): void => {
      this.requestMode(mode)
    },
    getMode: (): PermissionMode => this.modeChosen ?? this.modeConfirmed ?? 'default',
  }

  constructor(options: RemoteEngineOptions) {
    this.sessionId = options.sessionId
    this.port = options.port
    this.token = options.token
  }

  // ── Connection Management ───────────────────────────────────────────────

  /**
   * Ensure a WebSocket connection to the daemon exists.
   * Creates one lazily on the first process() or setMode() call.
   *
   * Concurrent callers **share** the in-flight attempt. Without that, the second caller
   * sees `this.ws` set but not yet `OPEN`, treats it as a stale socket, nulls its handlers
   * and closes it — so the first caller's promise can never settle (its `onopen` was
   * detached) and the message it was about to send goes to a socket nobody is listening on.
   */
  private ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve()
    }
    if (this.connecting) {
      return this.connecting
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

    const attempt = new Promise<void>((resolve, reject) => {
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

    this.connecting = attempt
    const clear = () => {
      if (this.connecting === attempt) this.connecting = null
    }
    // Both slots handled on purpose: this promise is only ever awaited by callers that
    // catch, but a rejection here would otherwise surface as unhandled.
    attempt.then(clear, clear)
    return attempt
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

    // Re-assert the mode this client's user picked, **before** the prompt — frames on one
    // socket arrive in the order they were sent, so the daemon applies the gate first and
    // this turn runs under the mode the user is looking at. Idempotent by design, and it
    // heals the two ways the gate can drift behind the client's back (a daemon restart, or
    // a worker evicted while idle and rebuilt from env).
    //
    // Skipped when nothing was ever picked here: the daemon owns the default (env config,
    // an earlier client, an operator), and a bystander must not overwrite it by asserting
    // the value it merely *displays*.
    if (this.modeChosen) await this.sendMode(this.modeChosen)

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
  // In remote attach mode, the daemon manages providers, agents and context. These stubs
  // satisfy the TUI's engine interface without introducing daemon dependencies into the
  // UI layer. (Permissions are **not** in this list: they are forwarded over the attach
  // protocol — see `getPermission` — because the footer is a display of the daemon's gate.)
  //
  // Slash commands may call any of these; we return safe defaults.

  /** No-op: provider switching is managed by the daemon session. */
  switchProvider(_providerId: string, _modelId?: string): void {}

  /** No-op: reasoning effort is managed by the daemon session. */
  setEffort(_level: string): void {}

  /** No-op: file-read tracking lives with the daemon's own engine. */
  resetFileTracking(): void {}

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

  /**
   * The permission surface the footer reads and writes — wired to the daemon's gate,
   * not a local mirror of it (`app.tsx` treats this line as **the mirror of execution**).
   *
   * Writing (`setMode`) sends `set_mode`; the daemon applies it to the session's live
   * `PermissionSystem` and answers with the mode that actually took effect. Reading
   * (`getMode`) answers optimistically until that answer arrives — see the field comments.
   */
  getPermission(): { setMode(mode: PermissionMode): void; getMode(): PermissionMode } {
    return this.permissionFacade
  }

  /**
   * Subscribe to mode corrections from the daemon (`mode` frames, and the `mode` field of
   * a `session_state` snapshot). Returns an unsubscribe function.
   *
   * Needed because the confirmed value can arrive **asynchronously** — a keypress is not a
   * render, so a footer that only ever read `getMode()` on keypress would keep displaying
   * the pre-clamp value forever. Nothing local has this problem: a local engine's
   * `getMode()` already reflects the clamp the moment `setMode` returns.
   */
  onPermissionModeChange(listener: (mode: PermissionMode) => void): () => void {
    this.modeListeners.add(listener)
    return () => {
      this.modeListeners.delete(listener)
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

    // Session facts, not prompt stream: they carry the gate's current mode and must be
    // absorbed even when nothing is consuming chunks (a keypress, not a turn).
    if (msg.type === 'mode' || msg.type === 'session_state') {
      // A snapshot describes the gate as of connect — see `absorbMode`.
      this.absorbMode(msg.mode, msg.type === 'session_state')
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

  // ── Permission plumbing ─────────────────────────────────────────────────

  /** Optimistically take the mode, then tell the daemon (best effort). */
  private requestMode(mode: PermissionMode): void {
    this.modeChosen = mode
    // Fire and forget: the correctness-critical send is the one `process()` makes before
    // every prompt. This one only shortens how long a footer can sit on a clamped value
    // (the daemon answers with `mode`, which usually lands before the next render).
    void this.sendMode(mode)
  }

  /** Send `set_mode`. Silent when the daemon is unreachable or the socket is closing. */
  private async sendMode(mode: PermissionMode): Promise<void> {
    try {
      await this.ensureConnected()
      const msg: ClientSetModeMessage = { type: 'set_mode', sessionId: this.sessionId, mode }
      this.ws?.send(JSON.stringify(msg))
    } catch {
      // No daemon: the mode stays local, exactly as it did before this existed. The next
      // `process()` re-asserts it, so nothing is lost if the connect was merely slow.
    }
  }

  /**
   * Take the daemon's word for the effective mode and hand it to the footer.
   *
   * Validated against `ALL_MODES` rather than trusted: this frame crosses a process
   * boundary and the two sides version independently (an older daemon need not send the
   * field at all), and a bad value would otherwise sit in the footer as a mode no wheel
   * slot can step away from.
   *
   * `fromSnapshot` separates the two kinds of frame, and they are **not** interchangeable:
   *
   * - a `mode` frame is the daemon **answering** — either a `set_mode` this client (or
   *   another) sent, or a live change. It is newer than anything we sent, so it replaces the
   *   request; that is the channel a clamp travels back on;
   * - `session_state` is sent the moment the socket attaches (`addClient` → `sendState`),
   *   so it describes the gate as of connect — i.e. **before** a `set_mode` this client had
   *   already sent could have been handled. Letting it retract the request would drop the
   *   standing instruction, and the very next prompt is what would do the dropping: the
   *   re-assert reads `modeChosen`, now holding the pre-request value, and helpfully pushes
   *   it — so `--permission plan` (or a `Shift+Tab` made just before a reconnect) would be
   *   silently **cancelled** rather than narrowed. It is not worth displaying either, since
   *   it is already superseded by a request that is in flight; the answer is what the footer
   *   needs, and the daemon always sends one for a `set_mode` it understood.
   */
  private absorbMode(mode: unknown, fromSnapshot = false): void {
    if (typeof mode !== 'string' || !ALL_MODES.includes(mode as PermissionMode)) return
    const effective = mode as PermissionMode
    this.modeConfirmed = effective
    if (this.modeChosen) {
      if (fromSnapshot) return
      this.modeChosen = effective
    }
    for (const listener of this.modeListeners) listener(effective)
  }

  /**
   * Map a ServerMessage from the daemon to a StreamChunk.
   * Returns null for message types that carry no prompt output. (`session_state` and
   * `mode` never reach here — `onMessage` absorbs them as session facts.)
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
          // 回程也要带上，否则字段出了 WS 就回不来 —— 接远端 daemon 的 CLI 依旧失明。
          isError: msg.isError,
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
