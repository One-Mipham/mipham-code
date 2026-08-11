# Daemon Phase 3: Agent System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Full agent lifecycle management — create, list, communicate with, and stop background agents across sessions. Agent-to-agent messaging. HTTP API + CLI commands.

**Architecture:** Agents table already exists in SQLite (Phase 1). Phase 3 adds the AgentManager service layer, REST endpoints for agent CRUD and messaging, WebSocket events for agent lifecycle, and CLI commands. The existing BackgroundAgentRegistry is migrated from in-memory to SQLite-backed.

**Tech Stack:** Bun + Phase 1-2 daemon infrastructure. No new npm deps.

## Global Constraints

- Bun 1.2+, TypeScript strict, no new npm deps
- Vitest with existing daemon test infrastructure
- Conventional Commits
- Agent state persisted to SQLite (agents table from Phase 1)
- Agent-to-agent messages routed through daemon message bus

## File Map

| File                                                | Purpose                                   |
| --------------------------------------------------- | ----------------------------------------- |
| Create `apps/cli/src/daemon/agent-manager.ts`       | Agent CRUD service layer                  |
| Create `apps/cli/src/daemon/message-bus.ts`         | Daemon-wide agent message routing         |
| Modify `apps/cli/src/daemon/server.ts`              | Agent endpoints + WS agent events         |
| Modify `apps/cli/src/daemon/index.ts`               | AgentManager + MessageBus in lifecycle    |
| Modify `apps/cli/bin/mipham.ts`                     | `mipham agents` + `mipham agent` commands |
| Modify `apps/cli/src/agent/background-registry.ts`  | SQLite persistence option                 |
| Create `apps/cli/test/daemon/agent-manager.test.ts` | Agent manager tests                       |
| Create `apps/cli/test/daemon/message-bus.test.ts`   | Message bus tests                         |

---

### Task 1: Agent Manager

Create `apps/cli/src/daemon/agent-manager.ts` — `AgentManager` class:

- `createAgent(sessionId, type, description, kind)` — inserts agent row, returns agent
- `getAgent(id)` / `listAgents(sessionId?)` / `listRunningAgents()` — queries
- `updateAgentStatus(id, status, result?, error?)` — status transitions
- `stopAgent(id)` — marks failed + sets error
- Uses Phase 1 `DaemonDatabase` agent methods

### Task 2: Daemon Message Bus

Create `apps/cli/src/daemon/message-bus.ts` — `MessageBus` class:

- `send(senderId, receiverId, content)` — enqueue message to receiver agent
- `poll(agentId)` — get pending messages for an agent
- `broadcastToSession(sessionId, content, excludeAgentId?)` — all agents in session
- Messages stored in-memory with TTL (5 min)
- Agent lookup by name and ID

### Task 3: Wire Agent Endpoints

Modify `apps/cli/src/daemon/server.ts`:

- `POST /api/v1/agents` — create agent (body: sessionId, agentType, description)
- `GET /api/v1/agents?session=:id` — list agents
- `GET /api/v1/agents/:id` — agent detail
- `POST /api/v1/agents/:id/message` — send message to agent (body: content)
- `DELETE /api/v1/agents/:id` — stop agent
- WS: `agent_created`, `agent_completed`, `agent_failed` lifecycle events

### Task 4: Daemon Lifecycle Integration

Modify `apps/cli/src/daemon/index.ts`:

- Create `AgentManager` + `MessageBus` in `startDaemon()`
- Pass to server
- Clean up in `stopDaemon()`

### Task 5: CLI Agent Commands

Modify `apps/cli/bin/mipham.ts`:

- `runAgentCLI()` — handles `mipham agents`, `mipham agent <id>`, `mipham agent message <id>`, `mipham agent stop <id>`
- Integrate into `main()` after attach handling
- Add to KNOWN_COMMANDS

### Task 6: BackgroundAgentRegistry SQLite Integration

Modify `apps/cli/src/agent/background-registry.ts`:

- Add optional `DaemonDatabase` parameter to `spawn()`
- When DB is provided, persist agent creation/completion to SQLite
- Backward compatible: works without DB (in-memory only)

### Task 7: Tests + Integration

- `test/daemon/agent-manager.test.ts` — CRUD tests
- `test/daemon/message-bus.test.ts` — message routing tests
- Full suite: all pass, no regressions
- Typecheck + format check
