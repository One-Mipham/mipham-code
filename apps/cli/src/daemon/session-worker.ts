// apps/cli/src/daemon/session-worker.ts — Phase 2 Core: Headless Prompt Processing
//
// SessionWorker wraps a QueryEngine and provides headless prompt processing
// with WebSocket streaming to attached clients. It is the central bridge
// between the HTTP/WS server and the AI query engine.
//
// Architecture:
//   SessionWorker
//     owns QueryEngine (AI processing — async generator)
//     owns DaemonDatabase reference (persistence — SQLite)
//     owns DaemonSession record (session metadata)
//     tracks WebSocket clients (real-time streaming to N viewers)
//
// Lifecycle:
//   1. Created when a session becomes active (on first attach or first prompt)
//   2. processPrompt() streams engine output to all WS clients
//   3. interrupt() aborts in-progress generation
//   4. getSessionState() serves attaching clients with full context
//   5. saveToDatabase() persists full conversation on close/checkpoint

import type { ServerWebSocket } from 'bun'
import type { QueryEngine } from '../core/engine'
import type { DaemonDatabase } from './database'
import type { DaemonSession, MessageRecord } from './types'
import type { StreamChunk } from '../shared/types'
import type {
  ClientInterruptMessage,
  ServerMessage,
  ServerTextMessage,
  ServerToolUseMessage,
  ServerToolResultMessage,
  ServerUsageMessage,
  ServerTaskNotificationMessage,
  ServerDoneMessage,
  ServerErrorMessage,
  ServerSessionStateMessage,
} from './attach-protocol'

// ── Session State Snapshot ────────────────────────────────────────────────

export interface SessionStateSnapshot {
  sessionId: string
  name: string
  provider: string
  model: string
  turnCount: number
  status: string
  /** Last N messages for context restoration on attach. */
  messages: MessageRecord[]
}

// ── SessionWorker ─────────────────────────────────────────────────────────

export class SessionWorker {
  private engine: QueryEngine
  private db: DaemonDatabase
  private session: DaemonSession
  private clients: Set<ServerWebSocket<unknown>> = new Set()
  private currentController: AbortController | null = null
  private processing = false

  constructor(engine: QueryEngine, db: DaemonDatabase, session: DaemonSession) {
    this.engine = engine
    this.db = db
    this.session = session
  }

  // ── Client Management ──────────────────────────────────────────────────

  /**
   * Add a WebSocket client to this session's broadcast set.
   * Sends a session_state snapshot to the newly attached client immediately.
   */
  addClient(ws: ServerWebSocket<unknown>): void {
    this.clients.add(ws)
    this.sendState(ws)
  }

  /** Remove a WebSocket client from this session's broadcast set. */
  removeClient(ws: ServerWebSocket<unknown>): void {
    this.clients.delete(ws)
  }

  /** Number of currently attached WebSocket clients. */
  getClientCount(): number {
    return this.clients.size
  }

  /** Whether a prompt is currently being processed. */
  isProcessing(): boolean {
    return this.processing
  }

  // ── Prompt Processing ──────────────────────────────────────────────────

  /**
   * Process a user prompt through the QueryEngine, streaming results to all
   * attached WebSocket clients and persisting messages to the database.
   *
   * Flow:
   *   1. Guard: reject if already processing
   *   2. Save user message to DB
   *   3. Call engine.process(prompt, signal) — async generator
   *   4. Map each StreamChunk → ServerMessage and broadcast to all clients
   *   5. On natural completion: save assistant content to DB, increment turn,
   *      broadcast `done`
   *   6. On error: broadcast `error` to clients, still increment turn
   *   7. On interrupt: save partial content, broadcast `done` with stop_reason
   *      'interrupted'
   */
  async processPrompt(prompt: string): Promise<void> {
    if (this.processing) {
      this.broadcast(this.errorMessage('A prompt is already being processed'))
      return
    }

    this.processing = true
    this.currentController = new AbortController()
    const signal = this.currentController.signal

    // Step 1: Persist the user message immediately
    this.db.saveMessage(this.session.id, 'user', JSON.stringify({ role: 'user', content: prompt }))

    // Step 2-3: Stream engine output to clients
    let assistantContent = ''
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let stopReason: string = 'end_turn'

    try {
      for await (const chunk of this.engine.process(prompt, signal)) {
        // Check for abort between chunks
        if (signal.aborted) {
          stopReason = 'interrupted'
          break
        }

        // Map the engine StreamChunk to the appropriate ServerMessage and broadcast
        const serverMsg = this.mapChunkToMessage(chunk)
        if (serverMsg) {
          this.broadcast(serverMsg)
        }

        // Accumulate assistant text content (used for final DB write)
        if (chunk.type === 'text' && chunk.content) {
          assistantContent += chunk.content
        }

        // Accumulate API-reported token usage (used for DB incrementTurn)
        if (chunk.type === 'usage') {
          if (chunk.inputTokens) totalInputTokens += chunk.inputTokens
          if (chunk.outputTokens) totalOutputTokens += chunk.outputTokens
        }

        // Stop signal from engine — includes 'stop' and 'error' types
        if (chunk.type === 'stop') {
          break
        }
      }
    } catch (err) {
      stopReason = 'error'
      this.broadcast(this.errorMessage(err instanceof Error ? err.message : String(err)))
    }

    // ── Check interrupt after catch (catch won't fire for AbortError in async generators) ──
    if (signal.aborted && stopReason !== 'error') {
      stopReason = 'interrupted'
    }

    // Step 4: Persist assistant response and finalize
    if (assistantContent) {
      // Save the final (or partial) assistant message
      this.db.saveMessage(
        this.session.id,
        'assistant',
        JSON.stringify({ role: 'assistant', content: assistantContent }),
      )
    }

    // Increment turn count with accumulated token usage
    this.db.incrementTurn(this.session.id, totalInputTokens, totalOutputTokens)

    // Refresh session metadata from DB so turnCount/tokenIn/tokenOut are up to date
    const refreshed = this.db.getSession(this.session.id)
    if (refreshed) {
      this.session = refreshed
    }

    // Broadcast completion
    const doneMsg: ServerDoneMessage = {
      type: 'done',
      sessionId: this.session.id,
      stopReason,
    }
    this.broadcast(doneMsg)

    this.currentController = null
    this.processing = false
  }

  // ── Interrupt ──────────────────────────────────────────────────────────

  /**
   * Abort the current prompt processing (if any).
   * Called when a client sends an interrupt message or when the session
   * is being force-closed.
   */
  interrupt(): void {
    if (this.currentController) {
      this.currentController.abort()
      this.currentController = null
    }
  }

  /** Handle an interrupt message from a WebSocket client. */
  handleClientInterrupt(_msg: ClientInterruptMessage): void {
    this.interrupt()
  }

  // ── Session State ──────────────────────────────────────────────────────

  /**
   * Return session state including messages, provider, model, and turn count.
   * Used by attaching clients to restore their conversation context.
   */
  getSessionState(): SessionStateSnapshot {
    const messages = this.db.getMessages(this.session.id, 100)
    return {
      sessionId: this.session.id,
      name: this.session.name,
      provider: this.session.provider,
      model: this.session.model,
      turnCount: this.session.turnCount,
      status: this.session.status,
      messages,
    }
  }

  /**
   * Return the session metadata record, refreshed from the database
   * to ensure turn count and token totals are current.
   */
  getSession(): DaemonSession {
    const fresh = this.db.getSession(this.session.id)
    if (fresh) {
      this.session = fresh
    }
    return this.session
  }

  /** Return the session ID for routing. */
  getSessionId(): string {
    return this.session.id
  }

  // ── Persistence ────────────────────────────────────────────────────────

  /**
   * Persist the full conversation state to the database.
   *
   * Syncs messages from the engine's ContextManager into the messages table,
   * avoiding duplicates by comparing message content hashes. Also updates
   * the session status in the sessions table.
   *
   * Called on session close or periodic checkpoint.
   */
  saveToDatabase(): void {
    const ctxMessages = this.engine.getContext().getMessages()
    const dbMessages = this.db.getMessages(this.session.id, 10000)

    // Build a set of already-persisted message keys
    const existingContents = new Set(dbMessages.map((m) => this.messageKey(m.role, m.content)))

    for (const msg of ctxMessages) {
      const role = msg.role
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      const key = this.messageKey(role, content)
      if (!existingContents.has(key)) {
        this.db.saveMessage(this.session.id, role, content)
        existingContents.add(key)
      }
    }

    // Sync session status
    this.db.updateSessionStatus(this.session.id, this.session.status)
  }

  // ── StreamChunk → ServerMessage Mapping ────────────────────────────────

  /**
   * Map an engine StreamChunk to the corresponding typed ServerMessage
   * from the attach protocol. Returns null for chunk types that don't
   * need to be broadcast (e.g., intermediate internal signals).
   */
  private mapChunkToMessage(chunk: StreamChunk): ServerMessage | null {
    switch (chunk.type) {
      case 'text': {
        const msg: ServerTextMessage = {
          type: 'text',
          sessionId: this.session.id,
          content: chunk.content ?? '',
        }
        return msg
      }

      case 'tool_use': {
        if (!chunk.toolUse) return null
        const msg: ServerToolUseMessage = {
          type: 'tool_use',
          sessionId: this.session.id,
          toolName: chunk.toolUse.name,
          toolInput: chunk.toolUse.input,
          toolId: chunk.toolUse.id,
        }
        return msg
      }

      case 'tool_result': {
        const msg: ServerToolResultMessage = {
          type: 'tool_result',
          sessionId: this.session.id,
          toolId: chunk.tool_use_id ?? 'unknown',
          content: chunk.content ?? '',
        }
        return msg
      }

      case 'usage': {
        const msg: ServerUsageMessage = {
          type: 'usage',
          sessionId: this.session.id,
          inputTokens: chunk.inputTokens ?? 0,
          outputTokens: chunk.outputTokens ?? 0,
        }
        return msg
      }

      case 'task_notification': {
        if (!chunk.taskNotification) return null
        const msg: ServerTaskNotificationMessage = {
          type: 'task_notification',
          sessionId: this.session.id,
          taskId: chunk.taskNotification.taskId,
          status: chunk.taskNotification.status,
        }
        return msg
      }

      case 'error': {
        const msg: ServerErrorMessage = {
          type: 'error',
          sessionId: this.session.id,
          message: chunk.error ?? 'Unknown error',
        }
        return msg
      }

      // 'stop' is handled by processPrompt() which sends ServerDoneMessage
      // 'thinking' is internal — model reasoning, not broadcast separately
      case 'stop':
      case 'thinking':
      default:
        return null
    }
  }

  // ── Internal Helpers ───────────────────────────────────────────────────

  /** Broadcast a ServerMessage to all attached WebSocket clients. */
  private broadcast(msg: ServerMessage): void {
    const raw = JSON.stringify(msg)
    for (const ws of this.clients) {
      try {
        ws.send(raw)
      } catch {
        // Client disconnected — eager cleanup (the server's WS close handler
        // will also remove it properly, this just avoids future send attempts).
        this.clients.delete(ws)
      }
    }
  }

  /** Send the current session state snapshot to a single WebSocket client. */
  private sendState(ws: ServerWebSocket<unknown>): void {
    const state = this.getSessionState()
    const msg: ServerSessionStateMessage = {
      type: 'session_state',
      sessionId: this.session.id,
      messages: state.messages,
      provider: state.provider,
      model: state.model,
      turnCount: state.turnCount,
    }
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      this.clients.delete(ws)
    }
  }

  /** Build an error ServerMessage for the current session. */
  private errorMessage(message: string): ServerErrorMessage {
    return {
      type: 'error',
      sessionId: this.session.id,
      message,
    }
  }

  /**
   * Generate a stable key for message deduplication.
   * Uses role + first 200 chars of content to avoid storing duplicate messages
   * while being tolerant of minor content variation.
   */
  private messageKey(role: string, content: string): string {
    return `${role}:${content.slice(0, 200)}`
  }
}
