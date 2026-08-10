# Daemon Phase 2: Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire QueryEngine into the daemon so sessions process prompts headlessly, stream results over WebSocket, persist conversation state across turns, and support `mipham attach` to reconnect the TUI.

**Architecture:** Each active session gets a long-lived `SessionWorker` that owns a `QueryEngine` instance. The daemon's HTTP server routes `POST /sessions/:id/prompt` to the worker, which calls `engine.process(prompt)` and streams token/tool events over WebSocket. The TUI (via `mipham attach`) connects to the WebSocket and renders identically to a local engine.

**Tech Stack:** Bun (Bun.serve + WebSocket), existing QueryEngine + tool system, Phase 1 daemon infrastructure.

## Global Constraints

- Bun 1.2+ runtime, TypeScript strict mode
- No new npm dependencies
- Test framework: Vitest (existing daemon Bun.serve mock from Phase 1)
- Commit convention: Conventional Commits
- Engine reuse: one QueryEngine per session worker (not recreated per turn)
- Session persistence: messages saved to SQLite via DaemonDatabase each turn
- Auth: Phase 1 authMiddleware applies to all API endpoints

---

## File Map

| File                                                      | Responsibility                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Create** `apps/cli/src/daemon/attach-protocol.ts`       | WebSocket message protocol types (client→daemon, daemon→client)                         |
| **Create** `apps/cli/src/daemon/session-worker.ts`        | Long-lived engine wrapper — owns QueryEngine, processes prompts, streams over WebSocket |
| **Create** `apps/cli/src/daemon/worker-pool.ts`           | Manages session workers — create, get, stop, idle timeout                               |
| **Modify** `apps/cli/src/daemon/server.ts`                | Wire POST /sessions/:id/prompt to worker pool; WebSocket message handler                |
| **Modify** `apps/cli/src/daemon/index.ts`                 | Integrate worker pool into daemon lifecycle                                             |
| **Create** `apps/cli/src/daemon/remote-engine.ts`         | WebSocket-based QueryEngine substitute for TUI attach                                   |
| **Modify** `apps/cli/bin/mipham.ts`                       | Add `mipham attach`, `mipham attach <id>`, `mipham attach --latest`                     |
| **Modify** `apps/cli/src/index.tsx`                       | Accept `remoteSession` option for remote mode                                           |
| **Modify** `apps/cli/src/ui/app.tsx`                      | Accept remote engine alongside local QueryEngine                                        |
| **Create** `apps/cli/test/daemon/session-worker.test.ts`  | Worker tests                                                                            |
| **Create** `apps/cli/test/daemon/attach-protocol.test.ts` | Protocol tests                                                                          |

---

### Task 1: Attach Protocol Types

**Files:** Create `apps/cli/src/daemon/attach-protocol.ts`

- [ ] **Step 1: Write protocol types**

```typescript
// apps/cli/src/daemon/attach-protocol.ts
// Client → Daemon: prompt, interrupt
// Daemon → Client: text, tool_use, tool_result, usage, task_notification, done, error, session_state

export interface ClientPromptMessage {
  type: 'prompt'
  sessionId: string
  prompt: string
}
export interface ClientInterruptMessage {
  type: 'interrupt'
  sessionId: string
}
export type ClientMessage = ClientPromptMessage | ClientInterruptMessage

export interface ServerTextMessage {
  type: 'text'
  sessionId: string
  content: string
}
export interface ServerToolUseMessage {
  type: 'tool_use'
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
  toolId: string
}
export interface ServerToolResultMessage {
  type: 'tool_result'
  sessionId: string
  toolId: string
  content: string
  isError?: boolean
}
export interface ServerUsageMessage {
  type: 'usage'
  sessionId: string
  inputTokens: number
  outputTokens: number
}
export interface ServerTaskNotificationMessage {
  type: 'task_notification'
  sessionId: string
  taskId: string
  status: string
}
export interface ServerDoneMessage {
  type: 'done'
  sessionId: string
  stopReason: string
}
export interface ServerErrorMessage {
  type: 'error'
  sessionId: string
  message: string
}
export interface ServerSessionStateMessage {
  type: 'session_state'
  sessionId: string
  messages: unknown[]
  provider: string
  model: string
  turnCount: number
}

export type ServerMessage =
  | ServerTextMessage
  | ServerToolUseMessage
  | ServerToolResultMessage
  | ServerUsageMessage
  | ServerTaskNotificationMessage
  | ServerDoneMessage
  | ServerErrorMessage
  | ServerSessionStateMessage
```

- [ ] **Step 2: Typecheck + commit**

---

### Task 2: Session Worker

**Files:** Create `apps/cli/src/daemon/session-worker.ts`

**Produces:** `SessionWorker` class — owns QueryEngine, processes prompts, broadcasts to WebSocket clients, saves messages to SQLite.

Key methods: `processPrompt(prompt)`, `interrupt()`, `addClient(ws)`, `removeClient(ws)`, `getSessionState()`, `saveToDatabase()`

- [ ] **Step 1: Implement** (full code in plan file)
- [ ] **Step 2: Typecheck + commit**

---

### Task 3: Worker Pool

**Files:** Create `apps/cli/src/daemon/worker-pool.ts`

**Produces:** `WorkerPool` class — manages SessionWorker lifecycle, idle timeout (30 min), graceful shutdown.

Key methods: `createWorker()`, `getWorker()`, `stopWorker()`, `stopAll()`, `resetIdleTimeout()`

- [ ] **Step 1: Implement** (full code in plan file)
- [ ] **Step 2: Typecheck + commit**

---

### Task 4: Wire Server Endpoints

**Files:** Modify `apps/cli/src/daemon/server.ts`

**Changes:**

- Accept `WorkerPool` in `ServerConfig`
- Replace `POST /sessions/:id/prompt` stub with real engine processing via worker pool
- Add WebSocket `message` handler — parse `ClientMessage`, route to worker
- Lazy-load engine dependencies (config → providers → engine) when creating workers

- [ ] **Step 1: Implement server changes**
- [ ] **Step 2: Verify existing server tests pass**
- [ ] **Step 3: Commit**

---

### Task 5: Daemon Lifecycle Integration

**Files:** Modify `apps/cli/src/daemon/index.ts`

**Changes:**

- Create `WorkerPool` in `startDaemon()`, pass to server
- Stop pool in `stopDaemon()`

- [ ] **Step 1: Implement, typecheck, commit**

---

### Task 6: Remote Engine

**Files:** Create `apps/cli/src/daemon/remote-engine.ts`

**Produces:** `RemoteEngine` class — WebSocket-based substitute for QueryEngine. Exposes `process(prompt, signal)` async generator identical to local engine, so TUI consumes it unchanged.

- [ ] **Step 1: Implement** (full code in plan file)
- [ ] **Step 2: Typecheck + commit**

---

### Task 7: CLI Attach Commands

**Files:** Modify `apps/cli/bin/mipham.ts`

**Produces:** `runAttachCLI()` — handles `mipham attach`, `mipham attach <id>`, `mipham attach --latest`. Lists active sessions from daemon, launches TUI in remote mode.

- [ ] **Step 1: Implement, integrate into main(), update KNOWN_COMMANDS and help**
- [ ] **Step 2: Typecheck + commit**

---

### Task 8: TUI Remote Mode

**Files:** Modify `apps/cli/src/index.tsx`, `apps/cli/src/ui/app.tsx`

**Changes:**

- `RunOptions` gets optional `remoteSession: { sessionId, port, token }`
- When set, create `RemoteEngine` instead of local QueryEngine
- Pass to TUI — the chunk iteration loop works identically

- [ ] **Step 1: Implement, typecheck, commit**

---

### Task 9: Tests + Integration

- [ ] **Step 1: Write `test/daemon/session-worker.test.ts`** — mock engine, verify prompt processing, broadcast, interrupt, SQLite save
- [ ] **Step 2: Write `test/daemon/attach-protocol.test.ts`** — message serialization, type guards
- [ ] **Step 3: Run full suite** — all tests pass, no regressions
- [ ] **Step 4: Typecheck + format check**
- [ ] **Step 5: Final commit**

---

## Phase 2 Deliverable

- `POST /api/v1/sessions/:id/prompt` processes through real QueryEngine
- WebSocket streams tokens, tool calls, results in real-time
- `mipham attach` / `mipham attach --latest` / `mipham attach <id>` reconnects TUI
- Messages auto-saved to SQLite each turn
- Idle timeout (30 min) gracefully stops inactive workers
