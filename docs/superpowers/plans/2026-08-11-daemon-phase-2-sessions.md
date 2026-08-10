# Daemon Phase 2: Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Wire QueryEngine into the daemon — headless prompt processing, WebSocket streaming, `mipham attach`.

**Architecture:** SessionWorker owns QueryEngine. Server routes prompts to workers. WebSocket streams tokens/tools. TUI attaches via RemoteEngine (WebSocket-based).

**Tech Stack:** Bun + existing QueryEngine + Phase 1 daemon. No new npm deps.

## Global Constraints

- Bun 1.2+, TypeScript strict, no new npm deps
- Vitest with existing Bun.serve mock
- Conventional Commits
- One QueryEngine per session worker
- Messages saved to SQLite each turn

## File Map

| File | Purpose |
|------|---------|
| Create `apps/cli/src/daemon/attach-protocol.ts` | WS message types |
| Create `apps/cli/src/daemon/session-worker.ts` | Engine wrapper, prompt processing, WS broadcast |
| Create `apps/cli/src/daemon/worker-pool.ts` | Worker lifecycle, idle timeout |
| Modify `apps/cli/src/daemon/server.ts` | Wire prompt endpoint + WS handler |
| Modify `apps/cli/src/daemon/index.ts` | WorkerPool in daemon lifecycle |
| Create `apps/cli/src/daemon/remote-engine.ts` | WS-based engine for TUI attach |
| Modify `apps/cli/bin/mipham.ts` | attach/attach --latest commands |
| Modify `apps/cli/src/index.tsx` | remoteSession option |
| Modify `apps/cli/src/ui/app.tsx` | Accept remote engine |
| Create `apps/cli/test/daemon/session-worker.test.ts` | Worker tests |
| Create `apps/cli/test/daemon/attach-protocol.test.ts` | Protocol tests |

---

### Task 1: Attach Protocol Types

Create `apps/cli/src/daemon/attach-protocol.ts` — WS message protocol:
- Client→Daemon: `ClientPromptMessage`, `ClientInterruptMessage`
- Daemon→Client: `ServerTextMessage`, `ServerToolUseMessage`, `ServerToolResultMessage`, `ServerUsageMessage`, `ServerDoneMessage`, `ServerErrorMessage`, `ServerSessionStateMessage`

### Task 2: Session Worker

Create `apps/cli/src/daemon/session-worker.ts` — `SessionWorker` class:
- Owns QueryEngine + ContextManager + ProviderRegistry
- `processPrompt(prompt)` — calls engine.process(), broadcasts chunks to WS clients
- `interrupt()` — aborts current generation
- `addClient(ws)` / `removeClient(ws)` — WS client tracking
- `getSessionState()` — returns messages, provider, model, turnCount for reconnection
- `saveToDatabase()` — persists messages to SQLite

### Task 3: Worker Pool

Create `apps/cli/src/daemon/worker-pool.ts` — `WorkerPool` class:
- `createWorker(sessionId, engine, context, registry)` — creates SessionWorker
- `getWorker(sessionId)` — returns existing worker
- `stopWorker(sessionId)` — interrupts, saves state, marks session idle
- `stopAll()` — graceful shutdown
- Idle timeout (30 min) — auto-stops inactive workers

### Task 4: Wire Server Endpoints

Modify `apps/cli/src/daemon/server.ts`:
- Accept `WorkerPool` in `ServerConfig`
- `POST /sessions/:id/prompt` — get/create worker, call processPrompt(), respond 200
- WS `message` handler — parse ClientMessage, route prompt/interrupt to worker
- Lazy-load engine deps when creating workers

### Task 5: Daemon Lifecycle Integration

Modify `apps/cli/src/daemon/index.ts`:
- Create `WorkerPool` in `startDaemon()`, pass to server
- Stop pool in `stopDaemon()`

### Task 6: Remote Engine

Create `apps/cli/src/daemon/remote-engine.ts` — `RemoteEngine` class:
- WebSocket-based QueryEngine substitute
- Exposes `process(prompt, signal)` async generator (same interface as local engine)
- TUI consumes identically

### Task 7: CLI Attach Commands

Modify `apps/cli/bin/mipham.ts`:
- `runAttachCLI()` — handles attach/attach <id>/attach --latest
- Lists active sessions from daemon HTTP API
- Launches TUI in remote mode via `runApp({ remoteSession: {...} })`
- Integrate into main()

### Task 8: TUI Remote Mode

Modify `apps/cli/src/index.tsx` + `apps/cli/src/ui/app.tsx`:
- Add `remoteSession` to `RunOptions`
- When set, create `RemoteEngine` instead of local QueryEngine
- TUI chunk loop unchanged

### Task 9: Tests + Integration

- `test/daemon/session-worker.test.ts` — mock engine, verify broadcast, SQLite save
- `test/daemon/attach-protocol.test.ts` — message serialization
- Full suite: all pass, no regressions
- Typecheck + format check
