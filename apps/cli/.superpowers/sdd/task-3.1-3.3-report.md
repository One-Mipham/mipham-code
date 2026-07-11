# Phase 3 — Agent View Dashboard: Task 3.1, 3.2, 3.3 Report

**Date**: 2026-07-11
**Status**: Complete
**Author**: Claude (Guohua Zhang)

---

## 3.1 — AgentViewManager

**File**: `apps/cli/src/agent-view/agent-view-manager.ts` (217 lines)

Multi-session lifecycle manager for background agent sessions.

### Exports

| Export                 | Type                                                    | Description                                                                        |
| ---------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `SessionStatus`        | `'needs-input' \| 'working' \| 'completed' \| 'failed'` | Four-state session lifecycle                                                       |
| `SessionMessage`       | interface                                               | `{ role, content }` lightweight message                                            |
| `AgentSession`         | interface                                               | Full session: id, title, status, provider, model, task, dates, elapsedMs, messages |
| `CreateSessionOptions` | interface                                               | Optional provider/model overrides                                                  |
| `SessionPeek`          | interface                                               | Session + up to 5 recent messages                                                  |
| `StatusGroups`         | type                                                    | `Record<SessionStatus, AgentSession[]>`                                            |
| `AgentViewManager`     | class                                                   | Multi-session lifecycle manager                                                    |

### AgentViewManager API

| Method                       | Returns                         | Description                                                        |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| `create(title, task, opts?)` | `AgentSession`                  | Creates new session with unique ID, initial status `needs-input`   |
| `list()`                     | `AgentSession[]`                | All sessions, newest first                                         |
| `groupByStatus()`            | `StatusGroups`                  | Sessions grouped into needs-input/working/completed/failed buckets |
| `get(id)`                    | `AgentSession \| undefined`     | Lookup by ID                                                       |
| `peek(id)`                   | `SessionPeek \| undefined`      | Session metadata + last 5 messages                                 |
| `attach(id)`                 | `AgentSession \| undefined`     | Transitions needs-input to working, returns session                |
| `kill(id)`                   | `boolean`                       | Marks session as failed (no-op if already terminal)                |
| `updateStatus(id, status)`   | `boolean`                       | Direct status transition with auto-timestamps                      |
| `addMessage(id, msg)`        | `boolean`                       | Append message to session history                                  |
| `countByStatus()`            | `Record<SessionStatus, number>` | Count sessions per status                                          |
| `prune()`                    | `number`                        | Remove completed/failed sessions, returns count removed            |

### Tests

**File**: `apps/cli/test/agent-view/agent-view-manager.test.ts` (150 lines, 5 tests)

| Test                                                  | What it verifies                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `should create a session with correct initial state`  | create() sets id, title, status='needs-input', provider, model, task, messages=[], elapsedMs=0, createdAt       |
| `should list all sessions and group them by status`   | list() returns all 3 sessions; groupByStatus() correctly partitions by status                                   |
| `should get, peek, and attach to a session`           | get() finds by id; peek() returns last 3 messages; attach() transitions needs-input->working and sets startedAt |
| `should kill active sessions and prune terminal ones` | kill() transitions to failed; cannot re-kill terminal; prune() removes 3 terminal sessions                      |
| `should count sessions by status`                     | countByStatus() returns correct counts (2 needs-input, 1 working)                                               |

---

## 3.2 — Dashboard TUI Components

### session-row.tsx

**File**: `apps/cli/src/agent-view/session-row.tsx` (64 lines)

Single session row with:

- **Selection indicator**: `❯` prefix + bold styling when selected
- **Status label**: Color-coded `[INPUT]`/`[WORK]`/`[DONE]`/`[FAIL]`
- **Session info**: `id · provider/model · elapsed time`
- **Task preview**: Truncated to 60 chars on second line
- **Elapsed formatting**: `<1s` / `Ns` / `Nm Xs` / `Nh Xm`

### session-peek.tsx

**File**: `apps/cli/src/agent-view/session-peek.tsx` (78 lines)

Peek popup panel (shown when Space is pressed on a session):

- **Header**: `Peek: agent-X · title · provider/model`
- **Messages**: Up to 5 recent messages with role-colored labels (green=user, cyan=assistant, yellow=system), truncated to 120 chars
- **Footer**: Message count, total count, session status
- **Border**: Single-line blue border

### dashboard.tsx

**File**: `apps/cli/src/agent-view/dashboard.tsx` (218 lines)

Full Ink TUI dashboard component:

- **Groups**: Sessions grouped by status (working > needs-input > completed > failed)
- **Navigation**: j/k to move selection, auto-clears peek on navigation
- **Peek**: Space toggles peek panel for selected session
- **Attach**: Enter triggers `onAttach()` callback via `manager.attach()`
- **Exit**: Esc closes peek (if open) or calls `onExit()`
- **Empty state**: "No background agents" with usage hint
- **Summary bar**: Total count + per-status counts with colors

---

## 3.3 — Wire CLI + Commands

### CLI Subcommand (`bin/mipham.ts` + `src/index.tsx`)

`mipham agents` launches the standalone Agent View Dashboard as an Ink app:

```typescript
// In runApp(), checked before the main chat app:
const args = process.argv.slice(2)
if (args[0] === 'agents') {
  const agentViewManager = new AgentViewManager()
  render(<AgentViewDashboard manager={agentViewManager} onExit={() => process.exit(0)} />)
}
```

### Slash Commands (`src/ui/commands.ts`)

**`/agents`** — Shows agent session summary:

Markdown-style listing with status icons, per-session elapsed time, provider/model, and task preview. References `mipham agents` for the full interactive dashboard.

**`/bg <prompt>`** — Spawn a background agent:

Creates a new `AgentSession` via `AgentViewManager.create()`, sets status to `working`, adds the prompt as a user message. Returns confirmation with session ID, task, provider, and model.

### Help Integration

Both `/agents` and `/bg` are registered in the help command output under a new "Agents" section.

### Engine Integration (`src/core/engine.ts`)

Added `agentViewManager` field with `setAgentViewManager()` / `getAgentViewManager()` accessors, wired from `runApp()`.

---

## Files Changed

### New Files (6)

| File                                         | Lines | Purpose                   |
| -------------------------------------------- | ----- | ------------------------- |
| `src/agent-view/agent-view-manager.ts`       | 217   | Session lifecycle manager |
| `src/agent-view/dashboard.tsx`               | 218   | Ink TUI dashboard         |
| `src/agent-view/session-row.tsx`             | 64    | Session row component     |
| `src/agent-view/session-peek.tsx`            | 78    | Peek popup component      |
| `test/agent-view/agent-view-manager.test.ts` | 150   | 5 tests                   |

### Modified Files (3)

| File                 | Changes                                                     |
| -------------------- | ----------------------------------------------------------- |
| `src/core/engine.ts` | +4 lines: import + AgentViewManager getter/setter           |
| `src/index.tsx`      | +16 lines: agents subcommand + AgentViewManager wiring      |
| `src/ui/commands.ts` | ~60 lines: /agents rewrite, /bg new, registry + help update |

---

## Verification Results

| Check                                                 | Status                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `bun test test/agent-view/agent-view-manager.test.ts` | **5 pass, 0 fail**                                                                         |
| `pnpm typecheck`                                      | **Clean** (0 errors)                                                                       |
| `bun test` (full suite)                               | **No new failures** (15 pre-existing: 9 exec.ts Bun compatibility, 6 e2e missing API keys) |
| Prettier formatting                                   | **Applied** to all new/modified files                                                      |
