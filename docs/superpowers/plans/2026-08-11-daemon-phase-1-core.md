# Daemon Phase 1: Core Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the daemon process foundation — HTTP+WebSocket server, SQLite persistence, session lifecycle management, and CLI daemon control commands.

**Architecture:** A Bun-native daemon process (`mipham daemon start`) runs an HTTP+WebSocket server on localhost. The server persists all state to SQLite. CLI interacts via HTTP. Phase 1 delivers daemon start/stop/status and session CRUD; subsequent phases add session workers, attach, agents, goals, and schedules.

**Tech Stack:** Bun (Bun.serve + WebSocket), better-sqlite3 (SQLite via bun:sqlite), existing QueryEngine and tool system

## Global Constraints

- Bun 1.2+ runtime (matches existing CLI)
- TypeScript strict mode
- Daemon port: `45671` (`MIPHAM_PORT` override)
- Default bind: `127.0.0.1` only (`MIPHAM_BIND=0.0.0.0` for external)
- Auth: Bearer token, auto-generated 64-char hex, stored at `~/.mipham/daemon.token`
- SQLite path: `~/.mipham/daemon.db`
- Backward compat: `mipham --no-daemon` preserves old single-process behavior
- Existing `~/.mipham/sessions/*.jsonl` auto-migrated on first daemon start
- No new npm dependencies — use Bun built-in `bun:sqlite` for SQLite
- Test framework: Vitest (existing)
- Commit convention: Conventional Commits

---

## File Map

| File | Responsibility |
|------|---------------|
| **Create** `apps/cli/src/daemon/types.ts` | Shared types for daemon sessions, agents, goals, schedules |
| **Create** `apps/cli/src/daemon/database.ts` | SQLite schema, migrations, CRUD operations for all tables |
| **Create** `apps/cli/src/daemon/auth.ts` | Token generation, validation, auth middleware |
| **Create** `apps/cli/src/daemon/session-manager.ts` | Session lifecycle, in-memory session registry, worker pool stub |
| **Create** `apps/cli/src/daemon/server.ts` | Bun.serve HTTP server + WebSocket upgrade, route handlers |
| **Create** `apps/cli/src/daemon/index.ts` | Daemon lifecycle: startDaemon(), stopDaemon(), getDaemonStatus() |
| **Create** `apps/cli/bin/daemon.ts` | Standalone daemon process entry point (spawned by CLI) |
| **Modify** `apps/cli/bin/mipham.ts` | Add `daemon start/stop/status/restart`, `--no-daemon` flag, auto-launch logic |
| **Create** `apps/cli/test/daemon/database.test.ts` | Database tests |
| **Create** `apps/cli/test/daemon/server.test.ts` | Server integration tests |
| **Create** `apps/cli/test/daemon/auth.test.ts` | Auth tests |

---

### Task 1: Daemon Types

**Files:**
- Create: `apps/cli/src/daemon/types.ts`

**Interfaces:**
- Produces: `DaemonSession`, `DaemonAgent`, `DaemonGoal`, `DaemonSchedule`, `DaemonStatus`, `SessionStatus`, `AgentStatus`, `AgentKind`, `GoalStatus`, `CreateSessionInput`

- [ ] **Step 1: Write the types file**

```typescript
// apps/cli/src/daemon/types.ts

export type SessionStatus = 'active' | 'idle' | 'compacting' | 'closed'
export type AgentStatus = 'running' | 'completed' | 'failed'
export type AgentKind = 'interactive' | 'forked' | 'attached' | 'unattended'
export type GoalStatus = 'active' | 'completed' | 'paused' | 'cleared'

export interface DaemonSession {
  id: string
  name: string
  cwd: string
  provider: string
  model: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
  closedAt: string | null
  turnCount: number
  tokenIn: number
  tokenOut: number
}

export interface CreateSessionInput {
  name: string
  cwd: string
  provider: string
  model: string
}

export interface DaemonAgent {
  id: string
  sessionId: string
  parentId: string | null
  agentType: string
  description: string
  status: AgentStatus
  kind: AgentKind
  worktree: string | null
  branch: string | null
  prUrl: string | null
  createdAt: string
  completedAt: string | null
  result: string | null
  error: string | null
}

export interface DaemonGoal {
  id: number
  sessionId: string
  description: string
  status: GoalStatus
  progress: { current: number; total: number; note?: string } | null
  createdAt: string
  updatedAt: string
}

export interface DaemonSchedule {
  id: number
  sessionId: string
  cronExpr: string
  prompt: string
  enabled: boolean
  lastFired: string | null
  nextFire: string
}

export interface DaemonStatus {
  pid: number
  port: number
  uptime: number // seconds since start
  activeSessions: number
  totalSessions: number
  activeAgents: number
  version: string
}

export interface MessageRecord {
  id: number
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string // JSON-serialized Message object
  createdAt: string
}

// HTTP API types
export interface ApiResponse<T> {
  ok: boolean
  data?: T
  error?: string
}

export interface CreateSessionResponse {
  session: DaemonSession
  authToken: string
}

export interface ListSessionsResponse {
  sessions: DaemonSession[]
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd apps/cli && pnpm typecheck
```
Expected: PASS (new file compiles without errors)

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/daemon/types.ts
git commit -m "feat(daemon): add daemon types (Session, Agent, Goal, Schedule)"
```

---

### Task 2: SQLite Database Layer

**Files:**
- Create: `apps/cli/src/daemon/database.ts`
- Create: `apps/cli/test/daemon/database.test.ts`

**Interfaces:**
- Consumes: `DaemonSession`, `DaemonAgent`, `DaemonGoal`, `DaemonSchedule`, `MessageRecord`, `CreateSessionInput` from `types.ts`
- Produces: `DaemonDatabase` class

- [ ] **Step 1: Write the failing test**

```typescript
// apps/cli/test/daemon/database.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DaemonDatabase } from '../../src/daemon/database'
import { unlinkSync } from 'node:fs'

const TEST_DB = '/tmp/mipham-daemon-test.db'

function cleanDb() {
  try { unlinkSync(TEST_DB) } catch {}
  try { unlinkSync(TEST_DB + '-wal') } catch {}
  try { unlinkSync(TEST_DB + '-shm') } catch {}
}

describe('DaemonDatabase', () => {
  let db: DaemonDatabase

  beforeAll(() => {
    cleanDb()
    db = new DaemonDatabase(TEST_DB)
    db.init()
  })

  afterAll(() => {
    db.close()
    cleanDb()
  })

  it('creates and retrieves a session', () => {
    const session = db.createSession({
      name: 'test-session',
      cwd: '/tmp/test-project',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    })

    expect(session.id).toBeDefined()
    expect(session.name).toBe('test-session')
    expect(session.status).toBe('active')

    const retrieved = db.getSession(session.id)
    expect(retrieved).not.toBeNull()
    expect(retrieved!.name).toBe('test-session')
  })

  it('lists only active sessions', () => {
    db.createSession({ name: 's1', cwd: '/tmp', provider: 'openai', model: 'gpt-5' })
    const s2 = db.createSession({ name: 's2', cwd: '/tmp', provider: 'deepseek', model: 'v3' })
    db.closeSession(s2.id)

    const active = db.listSessions('active')
    expect(active.length).toBe(2) // test-session + s1
    expect(active.every(s => s.status === 'active')).toBe(true)
  })

  it('saves and retrieves messages', () => {
    const session = db.createSession({ name: 'msg-test', cwd: '/tmp', provider: 'openai', model: 'gpt-5' })
    db.saveMessage(session.id, 'user', JSON.stringify({ role: 'user', content: 'hello' }))
    db.saveMessage(session.id, 'assistant', JSON.stringify({ role: 'assistant', content: [{
      type: 'text', text: 'hi!'
    }] }))

    const messages = db.getMessages(session.id)
    expect(messages.length).toBe(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[1]!.role).toBe('assistant')
  })

  it('respects message limit', () => {
    const session = db.createSession({ name: 'limit-test', cwd: '/tmp', provider: 'openai', model: 'gpt-5' })
    for (let i = 0; i < 10; i++) {
      db.saveMessage(session.id, 'user', JSON.stringify({ role: 'user', content: `msg-${i}` }))
    }
    const messages = db.getMessages(session.id, 5)
    expect(messages.length).toBe(5)
  })

  it('creates and lists agents', () => {
    const session = db.createSession({ name: 'agent-test', cwd: '/tmp', provider: 'anthropic', model: 'claude' })
    const agent = db.createAgent({
      id: 'agent-1',
      sessionId: session.id,
      parentId: null,
      agentType: 'general',
      description: 'test agent',
      status: 'running',
      kind: 'interactive',
      worktree: null,
      branch: null,
      prUrl: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      result: null,
      error: null,
    })

    expect(agent.id).toBe('agent-1')

    const agents = db.listAgents(session.id)
    expect(agents.length).toBe(1)
    expect(agents[0]!.description).toBe('test agent')
  })

  it('creates and updates goals', () => {
    const session = db.createSession({ name: 'goal-test', cwd: '/tmp', provider: 'openai', model: 'gpt-5' })
    const goalId = db.createGoal({
      sessionId: session.id,
      description: 'complete the feature',
      status: 'active',
      progress: { current: 3, total: 10 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    expect(goalId).toBeGreaterThan(0)

    db.updateGoal(goalId, { status: 'completed', progress: { current: 10, total: 10 } })
    const goals = db.getGoals(session.id)
    expect(goals[0]!.status).toBe('completed')
  })

  it('creates and deletes schedules', () => {
    const session = db.createSession({ name: 'sched-test', cwd: '/tmp', provider: 'openai', model: 'gpt-5' })
    const schedId = db.createSchedule({
      sessionId: session.id,
      cronExpr: '0 9 * * *',
      prompt: 'daily standup summary',
      enabled: true,
      lastFired: null,
      nextFire: new Date(Date.now() + 3600000).toISOString(),
    })
    expect(schedId).toBeGreaterThan(0)

    const due = db.getDueSchedules()
    expect(due.length).toBe(0) // not due yet (1 hour in future)

    db.deleteSchedule(schedId)
    const after = db.getSchedules(session.id)
    expect(after.length).toBe(0)
  })

  it('migrates JSONL sessions to SQLite', () => {
    // Create a fake JSONL session file
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const sessionsDir = join(process.env.HOME || '/tmp', '.mipham', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const oldSession = { metadata: { name: 'old-session', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', provider: 'openai', model: 'gpt-4', messageCount: 10, cwd: '/tmp' }, messages: [{ role: 'user', content: 'test' }] }
    writeFileSync(join(sessionsDir, 'old-session.jsonl'), JSON.stringify(oldSession))

    const count = db.migrateFromJsonl()
    expect(count).toBeGreaterThanOrEqual(1)

    // Clean up
    try { unlinkSync(join(sessionsDir, 'old-session.jsonl')) } catch {}
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd apps/cli && npx vitest run test/daemon/database.test.ts
```
Expected: FAIL — `DaemonDatabase` not defined

- [ ] **Step 3: Implement DaemonDatabase**

```typescript
// apps/cli/src/daemon/database.ts
import { Database } from 'bun:sqlite'
import type { DaemonSession, DaemonAgent, DaemonGoal, DaemonSchedule, MessageRecord, CreateSessionInput, SessionStatus } from './types'

export class DaemonDatabase {
  private db: Database
  private readonly path: string

  constructor(dbPath: string) {
    this.path = dbPath
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA foreign_keys=ON')
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        cwd         TEXT NOT NULL,
        provider    TEXT NOT NULL,
        model       TEXT NOT NULL,
        status      TEXT DEFAULT 'active',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        closed_at   TEXT,
        turn_count  INTEGER DEFAULT 0,
        token_in    INTEGER DEFAULT 0,
        token_out   INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

      CREATE TABLE IF NOT EXISTS agents (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        parent_id     TEXT REFERENCES agents(id),
        agent_type    TEXT NOT NULL,
        description   TEXT NOT NULL,
        status        TEXT DEFAULT 'running',
        kind          TEXT DEFAULT 'interactive',
        worktree      TEXT,
        branch        TEXT,
        pr_url        TEXT,
        created_at    TEXT NOT NULL,
        completed_at  TEXT,
        result        TEXT,
        error         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);

      CREATE TABLE IF NOT EXISTS goals (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        description   TEXT NOT NULL,
        status        TEXT DEFAULT 'active',
        progress      TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        cron_expr     TEXT NOT NULL,
        prompt        TEXT NOT NULL,
        enabled       INTEGER DEFAULT 1,
        last_fired    TEXT,
        next_fire     TEXT NOT NULL
      );
    `)
  }

  close(): void {
    this.db.close()
  }

  // ── Sessions ──────────────────────────────────────────────

  createSession(input: CreateSessionInput): DaemonSession {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO sessions (id, name, cwd, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      [id, input.name, input.cwd, input.provider, input.model, now, now],
    )
    return {
      id, name: input.name, cwd: input.cwd,
      provider: input.provider, model: input.model,
      status: 'active', createdAt: now, updatedAt: now,
      closedAt: null, turnCount: 0, tokenIn: 0, tokenOut: 0,
    }
  }

  getSession(id: string): DaemonSession | null {
    const row = this.db.query('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | null
    if (!row) return null
    return this.rowToSession(row)
  }

  listSessions(status?: string): DaemonSession[] {
    const sql = status
      ? 'SELECT * FROM sessions WHERE status = ? ORDER BY updated_at DESC'
      : 'SELECT * FROM sessions ORDER BY updated_at DESC'
    const rows = status
      ? this.db.query(sql).all(status) as Record<string, unknown>[]
      : this.db.query(sql).all() as Record<string, unknown>[]
    return rows.map(r => this.rowToSession(r))
  }

  updateSessionStatus(id: string, status: SessionStatus): void {
    const now = new Date().toISOString()
    const closedAt = status === 'closed' ? now : null
    this.db.run(
      `UPDATE sessions SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?`,
      [status, now, closedAt, id],
    )
  }

  closeSession(id: string): void {
    this.updateSessionStatus(id, 'closed')
  }

  incrementTurn(id: string, tokenIn: number, tokenOut: number): void {
    const now = new Date().toISOString()
    this.db.run(
      `UPDATE sessions SET turn_count = turn_count + 1, token_in = token_in + ?, token_out = token_out + ?, updated_at = ? WHERE id = ?`,
      [tokenIn, tokenOut, now, id],
    )
  }

  // ── Messages ──────────────────────────────────────────────

  saveMessage(sessionId: string, role: string, content: string): void {
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
      [sessionId, role, content, now],
    )
  }

  getMessages(sessionId: string, limit: number = 100): MessageRecord[] {
    const rows = this.db
      .query('SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?')
      .all(sessionId, limit) as Record<string, unknown>[]
    return rows.reverse().map(r => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      role: r.role as MessageRecord['role'],
      content: r.content as string,
      createdAt: r.created_at as string,
    }))
  }

  // ── Agents ─────────────────────────────────────────────────

  createAgent(agent: DaemonAgent): DaemonAgent {
    this.db.run(
      `INSERT INTO agents (id, session_id, parent_id, agent_type, description, status, kind, worktree, branch, pr_url, created_at, completed_at, result, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agent.id, agent.sessionId, agent.parentId, agent.agentType, agent.description,
       agent.status, agent.kind, agent.worktree, agent.branch, agent.prUrl,
       agent.createdAt, agent.completedAt, agent.result, agent.error],
    )
    return agent
  }

  getAgent(id: string): DaemonAgent | null {
    const row = this.db.query('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | null
    if (!row) return null
    return this.rowToAgent(row)
  }

  listAgents(sessionId?: string): DaemonAgent[] {
    const sql = sessionId
      ? 'SELECT * FROM agents WHERE session_id = ? ORDER BY created_at DESC'
      : 'SELECT * FROM agents ORDER BY created_at DESC'
    const rows = sessionId
      ? this.db.query(sql).all(sessionId) as Record<string, unknown>[]
      : this.db.query(sql).all() as Record<string, unknown>[]
    return rows.map(r => this.rowToAgent(r))
  }

  updateAgentStatus(id: string, status: string, result?: string, error?: string): void {
    const completedAt = status === 'completed' || status === 'failed' ? new Date().toISOString() : null
    this.db.run(
      `UPDATE agents SET status = ?, result = ?, error = ?, completed_at = ? WHERE id = ?`,
      [status, result ?? null, error ?? null, completedAt, id],
    )
  }

  // ── Goals ──────────────────────────────────────────────────

  createGoal(goal: Omit<DaemonGoal, 'id'>): number {
    const result = this.db.run(
      `INSERT INTO goals (session_id, description, status, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [goal.sessionId, goal.description, goal.status,
       goal.progress ? JSON.stringify(goal.progress) : null,
       goal.createdAt, goal.updatedAt],
    )
    return Number(result.lastInsertRowid)
  }

  getGoals(sessionId: string): DaemonGoal[] {
    const rows = this.db.query('SELECT * FROM goals WHERE session_id = ? ORDER BY id').all(sessionId) as Record<string, unknown>[]
    return rows.map(r => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      description: r.description as string,
      status: r.status as DaemonGoal['status'],
      progress: typeof r.progress === 'string' ? JSON.parse(r.progress as string) : null,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }))
  }

  updateGoal(id: number, updates: Partial<DaemonGoal>): void {
    const now = new Date().toISOString()
    const sets: string[] = ['updated_at = ?']
    const vals: unknown[] = [now]

    if (updates.status !== undefined) { sets.push('status = ?'); vals.push(updates.status) }
    if (updates.description !== undefined) { sets.push('description = ?'); vals.push(updates.description) }
    if (updates.progress !== undefined) {
      sets.push('progress = ?')
      vals.push(updates.progress ? JSON.stringify(updates.progress) : null)
    }

    vals.push(id)
    this.db.run(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`, vals)
  }

  // ── Schedules ──────────────────────────────────────────────

  createSchedule(schedule: Omit<DaemonSchedule, 'id'>): number {
    const result = this.db.run(
      `INSERT INTO schedules (session_id, cron_expr, prompt, enabled, last_fired, next_fire) VALUES (?, ?, ?, ?, ?, ?)`,
      [schedule.sessionId, schedule.cronExpr, schedule.prompt,
       schedule.enabled ? 1 : 0, schedule.lastFired, schedule.nextFire],
    )
    return Number(result.lastInsertRowid)
  }

  getSchedules(sessionId: string): DaemonSchedule[] {
    const rows = this.db.query('SELECT * FROM schedules WHERE session_id = ?').all(sessionId) as Record<string, unknown>[]
    return rows.map(r => this.rowToSchedule(r))
  }

  deleteSchedule(id: number): void {
    this.db.run('DELETE FROM schedules WHERE id = ?', [id])
  }

  getDueSchedules(): DaemonSchedule[] {
    const now = new Date().toISOString()
    const rows = this.db.query(
      'SELECT * FROM schedules WHERE enabled = 1 AND next_fire <= ?',
    ).all(now) as Record<string, unknown>[]
    return rows.map(r => this.rowToSchedule(r))
  }

  // ── Migration ──────────────────────────────────────────────

  migrateFromJsonl(): number {
    const { readdirSync, readFileSync, existsSync } = require('node:fs')
    const { join } = require('node:path')
    const sessionsDir = join(process.env.HOME || '/tmp', '.mipham', 'sessions')

    if (!existsSync(sessionsDir)) return 0

    const files = readdirSync(sessionsDir).filter((f: string) => f.endsWith('.jsonl'))
    let count = 0

    for (const file of files) {
      try {
        const raw = readFileSync(join(sessionsDir, file), 'utf-8')
        const session = JSON.parse(raw)
        if (!session.metadata || !Array.isArray(session.messages)) continue

        const id = crypto.randomUUID()
        const name = session.metadata.name || file.replace('.jsonl', '')
        this.createSession({
          name,
          cwd: session.metadata.cwd || process.cwd(),
          provider: session.metadata.provider || 'unknown',
          model: session.metadata.model || 'unknown',
        })

        // Override the auto-generated ID with a stable one for migration
        this.db.run('UPDATE sessions SET id = ? WHERE name = ?', [id, name])

        for (const msg of session.messages) {
          this.saveMessage(id, msg.role || 'user', JSON.stringify(msg))
        }

        count++
      } catch {
        // Skip corrupt files
      }
    }

    return count
  }

  // ── Stats ──────────────────────────────────────────────────

  getStats(): { activeSessions: number; totalSessions: number; activeAgents: number } {
    const activeSessions = (this.db.query(
      "SELECT COUNT(*) as c FROM sessions WHERE status != 'closed'",
    ).get() as { c: number }).c
    const totalSessions = (this.db.query(
      'SELECT COUNT(*) as c FROM sessions',
    ).get() as { c: number }).c
    const activeAgents = (this.db.query(
      "SELECT COUNT(*) as c FROM agents WHERE status = 'running'",
    ).get() as { c: number }).c
    return { activeSessions, totalSessions, activeAgents }
  }

  // ── Helpers ────────────────────────────────────────────────

  private rowToSession(row: Record<string, unknown>): DaemonSession {
    return {
      id: row.id as string,
      name: row.name as string,
      cwd: row.cwd as string,
      provider: row.provider as string,
      model: row.model as string,
      status: row.status as SessionStatus,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      closedAt: row.closed_at as string | null,
      turnCount: row.turn_count as number,
      tokenIn: row.token_in as number,
      tokenOut: row.token_out as number,
    }
  }

  private rowToAgent(row: Record<string, unknown>): DaemonAgent {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      parentId: row.parent_id as string | null,
      agentType: row.agent_type as string,
      description: row.description as string,
      status: row.status as DaemonAgent['status'],
      kind: row.kind as DaemonAgent['kind'],
      worktree: row.worktree as string | null,
      branch: row.branch as string | null,
      prUrl: row.pr_url as string | null,
      createdAt: row.created_at as string,
      completedAt: row.completed_at as string | null,
      result: row.result as string | null,
      error: row.error as string | null,
    }
  }

  private rowToSchedule(row: Record<string, unknown>): DaemonSchedule {
    return {
      id: row.id as number,
      sessionId: row.session_id as string,
      cronExpr: row.cron_expr as string,
      prompt: row.prompt as string,
      enabled: (row.enabled as number) === 1,
      lastFired: row.last_fired as string | null,
      nextFire: row.next_fire as string,
    }
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd apps/cli && npx vitest run test/daemon/database.test.ts
```
Expected: ALL TESTS PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/daemon/database.ts apps/cli/test/daemon/database.test.ts
git commit -m "feat(daemon): SQLite database layer with migration from JSONL"
```

---

### Task 3: Daemon Auth (Token Management)

**Files:**
- Create: `apps/cli/src/daemon/auth.ts`
- Create: `apps/cli/test/daemon/auth.test.ts`

**Interfaces:**
- Produces: `generateToken()`, `loadOrCreateToken()`, `verifyToken()`, `authMiddleware()`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/cli/test/daemon/auth.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { generateToken, verifyToken, loadOrCreateToken } from '../../src/daemon/auth'
import { unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const TEST_TOKEN_FILE = join(process.env.HOME || '/tmp', '.mipham', 'daemon-test.token')

describe('Daemon Auth', () => {
  afterAll(() => {
    try { unlinkSync(TEST_TOKEN_FILE) } catch {}
  })

  it('generates a 64-char hex token', () => {
    const token = generateToken()
    expect(token.length).toBe(64)
    expect(/^[0-9a-f]+$/.test(token)).toBe(true)
  })

  it('generates unique tokens each time', () => {
    const t1 = generateToken()
    const t2 = generateToken()
    expect(t1).not.toBe(t2)
  })

  it('loads existing token or creates new one', () => {
    // Clean state
    try { unlinkSync(TEST_TOKEN_FILE) } catch {}

    const token1 = loadOrCreateToken(TEST_TOKEN_FILE)
    expect(token1.length).toBe(64)
    expect(existsSync(TEST_TOKEN_FILE)).toBe(true)

    // Second call should return same token
    const token2 = loadOrCreateToken(TEST_TOKEN_FILE)
    expect(token2).toBe(token1)
  })

  it('verifies token correctly', () => {
    const token = generateToken()
    expect(verifyToken(token, token)).toBe(true)
    expect(verifyToken(token, 'wrong-token')).toBe(false)
    expect(verifyToken(token, '')).toBe(false)
  })

  it('uses constant-time comparison', () => {
    // verifyToken uses timing-safe comparison via Bun.password.constantTimeCompare
    const token = generateToken()
    // Wrong length should still fail safely
    expect(verifyToken(token, 'short')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd apps/cli && npx vitest run test/daemon/auth.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement auth module**

```typescript
// apps/cli/src/daemon/auth.ts
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * Generate a 64-character hex token using cryptographically secure random bytes.
 */
export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Load an existing token from disk, or create one if it doesn't exist.
 * The token file is created with 0o600 permissions.
 */
export function loadOrCreateToken(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, 'utf-8').trim()
  }

  const token = generateToken()
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 })
  writeFileSync(tokenPath, token, { mode: 0o600 })
  return token
}

/**
 * Verify a provided token against the expected token.
 * Uses Bun's constant-time comparison to prevent timing attacks.
 */
export function verifyToken(expected: string, provided: string): boolean {
  if (!provided || !expected) return false
  return Bun.password.constantTimeCompare(
    Buffer.from(expected),
    Buffer.from(provided),
  )
}

/**
 * Create an auth middleware for Bun.serve that checks the Authorization header.
 * Returns a Response if auth fails, or null if auth passes.
 */
export function authMiddleware(
  request: Request,
  validToken: string,
): Response | null {
  // Allow health endpoint without auth
  const url = new URL(request.url)
  if (url.pathname === '/api/v1/health') return null

  // localhost requests skip auth
  const host = request.headers.get('host') || ''
  if (host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]')) {
    return null
  }

  const auth = request.headers.get('authorization')
  if (!auth || !auth.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing authorization header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const token = auth.slice(7)
  if (!verifyToken(validToken, token)) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid token' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return null
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd apps/cli && npx vitest run test/daemon/auth.test.ts
```
Expected: ALL TESTS PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/daemon/auth.ts apps/cli/test/daemon/auth.test.ts
git commit -m "feat(daemon): token generation, verification, and auth middleware"
```

---

### Task 4: Session Manager

**Files:**
- Create: `apps/cli/src/daemon/session-manager.ts`
- Create: `apps/cli/test/daemon/session-manager.test.ts`

**Interfaces:**
- Consumes: `DaemonDatabase` from `database.ts`, `DaemonSession`, `CreateSessionInput` from `types.ts`
- Produces: `SessionManager` class

- [ ] **Step 1: Write the failing test**

```typescript
// apps/cli/test/daemon/session-manager.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SessionManager } from '../../src/daemon/session-manager'
import { DaemonDatabase } from '../../src/daemon/database'
import { unlinkSync } from 'node:fs'

const TEST_DB = '/tmp/mipham-sm-test.db'

describe('SessionManager', () => {
  let db: DaemonDatabase
  let sm: SessionManager

  beforeAll(() => {
    try { unlinkSync(TEST_DB) } catch {}
    try { unlinkSync(TEST_DB + '-wal') } catch {}
    try { unlinkSync(TEST_DB + '-shm') } catch {}
    db = new DaemonDatabase(TEST_DB)
    db.init()
    sm = new SessionManager(db)
  })

  afterAll(() => {
    db.close()
    try { unlinkSync(TEST_DB) } catch {}
  })

  it('creates a session with defaults', () => {
    const session = sm.createSession('my-session', '/tmp/project', 'anthropic', 'claude-sonnet-5')
    expect(session.id).toBeDefined()
    expect(session.name).toBe('my-session')
    expect(session.status).toBe('active')
    expect(session.cwd).toBe('/tmp/project')
  })

  it('returns active session count', () => {
    expect(sm.getActiveCount()).toBeGreaterThanOrEqual(1)
  })

  it('closes a session', () => {
    const s = sm.createSession('to-close', '/tmp', 'openai', 'gpt-5')
    sm.closeSession(s.id)
    const closed = sm.getSession(s.id)
    expect(closed!.status).toBe('closed')
    expect(closed!.closedAt).not.toBeNull()
  })

  it('lists only active sessions', () => {
    const active = sm.listSessions('active')
    expect(active.every(s => s.status === 'active')).toBe(true)
  })

  it('notifies onClose callback when session is closed', () => {
    let closedId = ''
    sm.onSessionClosed((id) => { closedId = id })

    const s = sm.createSession('cb-test', '/tmp', 'openai', 'gpt-5')
    sm.closeSession(s.id)
    expect(closedId).toBe(s.id)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd apps/cli && npx vitest run test/daemon/session-manager.test.ts
```
Expected: FAIL

- [ ] **Step 3: Implement SessionManager**

```typescript
// apps/cli/src/daemon/session-manager.ts
import type { DaemonDatabase } from './database'
import type { DaemonSession, CreateSessionInput, SessionStatus } from './types'

type SessionCloseCallback = (sessionId: string) => void

export class SessionManager {
  private db: DaemonDatabase
  private closeCallbacks: SessionCloseCallback[] = []

  constructor(db: DaemonDatabase) {
    this.db = db
  }

  createSession(name: string, cwd: string, provider: string, model: string): DaemonSession {
    return this.db.createSession({ name, cwd, provider, model })
  }

  getSession(id: string): DaemonSession | null {
    return this.db.getSession(id)
  }

  listSessions(status?: string): DaemonSession[] {
    return this.db.listSessions(status)
  }

  closeSession(id: string): void {
    this.db.closeSession(id)
    for (const cb of this.closeCallbacks) {
      try { cb(id) } catch { /* callback errors should not propagate */ }
    }
  }

  getActiveCount(): number {
    const stats = this.db.getStats()
    return stats.activeSessions
  }

  onSessionClosed(callback: SessionCloseCallback): void {
    this.closeCallbacks.push(callback)
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd apps/cli && npx vitest run test/daemon/session-manager.test.ts
```
Expected: ALL TESTS PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/daemon/session-manager.ts apps/cli/test/daemon/session-manager.test.ts
git commit -m "feat(daemon): session manager with lifecycle and close callbacks"
```

---

### Task 5: HTTP + WebSocket Server

**Files:**
- Create: `apps/cli/src/daemon/server.ts`
- Create: `apps/cli/test/daemon/server.test.ts`

**Interfaces:**
- Consumes: `DaemonDatabase` from `database.ts`, `SessionManager` from `session-manager.ts`, `authMiddleware` from `auth.ts`, `DaemonSession` from `types.ts`
- Produces: `createServer()`, `DaemonServer` type

- [ ] **Step 1: Write the failing test**

```typescript
// apps/cli/test/daemon/server.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer } from '../../src/daemon/server'
import { DaemonDatabase } from '../../src/daemon/database'
import { SessionManager } from '../../src/daemon/session-manager'
import { generateToken } from '../../src/daemon/auth'
import { unlinkSync } from 'node:fs'
import type { Server } from 'bun'

const TEST_DB = '/tmp/mipham-server-test.db'
const TEST_PORT = 45999
const TEST_TOKEN = generateToken()

function cleanDb() {
  try { unlinkSync(TEST_DB) } catch {}
  try { unlinkSync(TEST_DB + '-wal') } catch {}
  try { unlinkSync(TEST_DB + '-shm') } catch {}
}

function apiUrl(path: string): string {
  return `http://127.0.0.1:${TEST_PORT}${path}`
}

async function fetchApi(path: string, options?: RequestInit) {
  return fetch(apiUrl(path), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TEST_TOKEN}`,
      ...(options?.headers || {}),
    },
  })
}

describe('Daemon HTTP Server', () => {
  let server: Server
  let db: DaemonDatabase
  let sm: SessionManager

  beforeAll(async () => {
    cleanDb()
    db = new DaemonDatabase(TEST_DB)
    db.init()
    sm = new SessionManager(db)
    server = createServer({ db, sm, token: TEST_TOKEN, port: TEST_PORT, hostname: '127.0.0.1' })
  })

  afterAll(() => {
    server.stop()
    db.close()
    cleanDb()
  })

  it('GET /api/v1/health returns ok', async () => {
    const res = await fetch(apiUrl('/api/v1/health'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.pid).toBeGreaterThan(0)
    expect(body.port).toBe(TEST_PORT)
  })

  it('POST /api/v1/sessions creates a session', async () => {
    const res = await fetchApi('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'api-test',
        cwd: '/tmp/test',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      }),
    })
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.ok).toBe(true)
    expect(body.data.session.name).toBe('api-test')
    expect(body.data.session.status).toBe('active')
  })

  it('GET /api/v1/sessions lists sessions', async () => {
    const res = await fetchApi('/api/v1/sessions')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.data.sessions)).toBe(true)
  })

  it('DELETE /api/v1/sessions/:id closes a session', async () => {
    // Create first
    const create = await fetchApi('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: 'to-delete', cwd: '/tmp', provider: 'openai', model: 'gpt-5' }),
    })
    const { session } = (await create.json()).data

    // Close it
    const del = await fetchApi(`/api/v1/sessions/${session.id}`, { method: 'DELETE' })
    const body = await del.json()
    expect(del.status).toBe(200)
    expect(body.ok).toBe(true)

    // Verify closed
    const get = await fetchApi(`/api/v1/sessions/${session.id}`)
    const getBody = await get.json()
    expect(getBody.data.session.status).toBe('closed')
  })

  it('rejects requests without auth when not localhost', async () => {
    // Simulate external request (no localhost host header)
    const res = await fetch(apiUrl('/api/v1/sessions'), {
      headers: { 'Content-Type': 'application/json', 'Host': 'external.example.com' },
    })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run test — verify it fails**

```bash
cd apps/cli && npx vitest run test/daemon/server.test.ts
```
Expected: FAIL — `createServer` not defined

- [ ] **Step 3: Implement HTTP + WebSocket server**

```typescript
// apps/cli/src/daemon/server.ts
import type { Server, ServerWebSocket } from 'bun'
import type { DaemonDatabase } from './database'
import type { SessionManager } from './session-manager'
import { authMiddleware } from './auth'

interface ServerConfig {
  db: DaemonDatabase
  sm: SessionManager
  token: string
  port: number
  hostname: string
}

interface WsData {
  sessionId: string
}

export function createServer(config: ServerConfig): Server {
  const { db, sm, token, port, hostname } = config

  const wsClients = new Map<string, Set<ServerWebSocket<WsData>>>()

  function broadcast(sessionId: string, data: unknown): void {
    const clients = wsClients.get(sessionId)
    if (!clients) return
    const msg = JSON.stringify(data)
    for (const ws of clients) {
      try { ws.send(msg) } catch { clients.delete(ws) }
    }
  }

  const server = Bun.serve({
    port,
    hostname,
    fetch(req, server) {
      // Auth check (skipped for localhost)
      const authError = authMiddleware(req, token)
      if (authError) return authError

      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method

      // WebSocket upgrade
      const streamMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/stream$/)
      if (streamMatch && server.upgrade(req, { data: { sessionId: streamMatch[1]! } })) {
        return // upgraded
      }

      // Parse body helper
      async function jsonBody(): Promise<Record<string, unknown>> {
        try { return await req.json() } catch { return {} }
      }

      // ── Health ──────────────────────────────────────
      if (method === 'GET' && path === '/api/v1/health') {
        const stats = db.getStats()
        return Response.json({
          ok: true,
          pid: process.pid,
          port,
          uptime: process.uptime(),
          activeSessions: stats.activeSessions,
          totalSessions: stats.totalSessions,
          activeAgents: stats.activeAgents,
          version: '0.31.1',
        })
      }

      // ── Stats ───────────────────────────────────────
      if (method === 'GET' && path === '/api/v1/stats') {
        const stats = db.getStats()
        return Response.json({ ok: true, data: stats })
      }

      // ── Sessions CRUD ───────────────────────────────
      if (method === 'POST' && path === '/api/v1/sessions') {
        const body = await jsonBody()
        const session = sm.createSession(
          (body.name as string) || 'unnamed',
          (body.cwd as string) || process.cwd(),
          (body.provider as string) || 'unknown',
          (body.model as string) || 'unknown',
        )
        return Response.json({ ok: true, data: { session } }, { status: 201 })
      }

      if (method === 'GET' && path === '/api/v1/sessions') {
        const status = url.searchParams.get('status') || undefined
        const sessions = sm.listSessions(status)
        return Response.json({ ok: true, data: { sessions } })
      }

      const sessionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)$/)
      if (sessionMatch && method === 'GET') {
        const session = sm.getSession(sessionMatch[1]!)
        if (!session) {
          return Response.json({ ok: false, error: 'Session not found' }, { status: 404 })
        }
        return Response.json({ ok: true, data: { session } })
      }

      if (sessionMatch && method === 'DELETE') {
        sm.closeSession(sessionMatch[1]!)
        return Response.json({ ok: true })
      }

      // ── Session messages ────────────────────────────
      const messagesMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/)
      if (messagesMatch && method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '100')
        const messages = db.getMessages(messagesMatch[1]!, limit)
        return Response.json({ ok: true, data: { messages } })
      }

      // ── Prompt (stub — Phase 2) ─────────────────────
      const promptMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)\/prompt$/)
      if (promptMatch && method === 'POST') {
        const body = await jsonBody()
        const sessionId = promptMatch[1]!
        const prompt = body.prompt as string

        // Phase 1 stub: save the user message, return placeholder
        db.saveMessage(sessionId, 'user', JSON.stringify({ role: 'user', content: prompt }))

        // Broadcast via WebSocket for real-time streaming clients
        broadcast(sessionId, { type: 'prompt_received', sessionId, prompt })

        return Response.json({
          ok: true,
          data: {
            sessionId,
            message: 'Prompt received. Full execution coming in Phase 2.',
          },
        })
      }

      // ── Agents (stub — Phase 3) ─────────────────────
      if (method === 'GET' && path === '/api/v1/agents') {
        const sessionId = url.searchParams.get('session') || undefined
        const agents = db.listAgents(sessionId)
        return Response.json({ ok: true, data: { agents } })
      }

      // ── Goals (stub — Phase 4) ──────────────────────
      if (method === 'GET' && path === '/api/v1/goals') {
        const sessionId = url.searchParams.get('session')
        if (!sessionId) return Response.json({ ok: false, error: '?session= required' }, { status: 400 })
        const goals = db.getGoals(sessionId)
        return Response.json({ ok: true, data: { goals } })
      }

      if (method === 'POST' && path === '/api/v1/goals') {
        const body = await jsonBody()
        const now = new Date().toISOString()
        const goalId = db.createGoal({
          sessionId: body.sessionId as string,
          description: body.description as string,
          status: 'active',
          progress: body.progress as DaemonGoal['progress'] || null,
          createdAt: now,
          updatedAt: now,
        })
        return Response.json({ ok: true, data: { id: goalId } }, { status: 201 })
      }

      // ── Schedules (stub — Phase 4) ──────────────────
      if (method === 'GET' && path === '/api/v1/schedules') {
        const sessionId = url.searchParams.get('session')
        if (!sessionId) return Response.json({ ok: false, error: '?session= required' }, { status: 400 })
        const schedules = db.getSchedules(sessionId)
        return Response.json({ ok: true, data: { schedules } })
      }

      return Response.json({ ok: false, error: 'Not found' }, { status: 404 })
    },

    websocket: {
      open(ws) {
        const data = ws.data as WsData
        if (!wsClients.has(data.sessionId)) {
          wsClients.set(data.sessionId, new Set())
        }
        wsClients.get(data.sessionId)!.add(ws)
      },
      close(ws) {
        const data = ws.data as WsData
        const clients = wsClients.get(data.sessionId)
        if (clients) {
          clients.delete(ws)
          if (clients.size === 0) wsClients.delete(data.sessionId)
        }
      },
      message() {
        // Client-to-server WS messages handled in Phase 2
      },
    },
  })

  return server
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd apps/cli && npx vitest run test/daemon/server.test.ts
```
Expected: ALL TESTS PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/daemon/server.ts apps/cli/test/daemon/server.test.ts
git commit -m "feat(daemon): HTTP + WebSocket server with session CRUD endpoints"
```

---

### Task 6: Daemon Lifecycle (start/stop/status)

**Files:**
- Create: `apps/cli/src/daemon/index.ts`

**Interfaces:**
- Consumes: `DaemonDatabase` from `database.ts`, `SessionManager` from `session-manager.ts`, `createServer` from `server.ts`, `loadOrCreateToken` from `auth.ts`
- Produces: `startDaemon()`, `stopDaemon()`, `getDaemonStatus()`, `getPort()`

- [ ] **Step 1: Write daemon lifecycle module**

```typescript
// apps/cli/src/daemon/index.ts
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Server } from 'bun'
import { DaemonDatabase } from './database'
import { SessionManager } from './session-manager'
import { createServer } from './server'
import { loadOrCreateToken } from './auth'
import type { DaemonStatus } from './types'

const HOME = homedir()
const MIPHAM_HOME = join(HOME, '.mipham')
const DB_PATH = join(MIPHAM_HOME, 'daemon.db')
const TOKEN_PATH = join(MIPHAM_HOME, 'daemon.token')
const PID_FILE = join(MIPHAM_HOME, 'daemon.pid')
const PORT_FILE = join(MIPHAM_HOME, 'daemon.port')

const DEFAULT_PORT = 45671

let activeServer: Server | null = null
let activeDb: DaemonDatabase | null = null

function getConfiguredPort(): number {
  if (process.env.MIPHAM_PORT) {
    const p = parseInt(process.env.MIPHAM_PORT, 10)
    if (!isNaN(p) && p > 0 && p < 65536) return p
  }
  return DEFAULT_PORT
}

function getConfiguredBind(): string {
  return process.env.MIPHAM_BIND || '127.0.0.1'
}

function findAvailablePort(startPort: number): number {
  // Try ports in sequence; for production, Bun.serve will throw if port is taken
  // and we can retry. For simplicity, we try startPort..startPort+9
  return startPort
}

export function getPort(): number {
  if (existsSync(PORT_FILE)) {
    try {
      return parseInt(readFileSync(PORT_FILE, 'utf-8').trim(), 10)
    } catch {}
  }
  return DEFAULT_PORT
}

export async function startDaemon(): Promise<{ port: number; token: string }> {
  mkdirSync(MIPHAM_HOME, { recursive: true, mode: 0o700 })

  const port = findAvailablePort(getConfiguredPort())
  const hostname = getConfiguredBind()
  const token = loadOrCreateToken(TOKEN_PATH)

  // Initialize database
  const db = new DaemonDatabase(DB_PATH)
  db.init()
  activeDb = db

  // Run migration on first start
  const sessionsCount = db.listSessions().length
  if (sessionsCount === 0) {
    const migrated = db.migrateFromJsonl()
    if (migrated > 0) {
      console.log(`Daemon: migrated ${migrated} JSONL sessions to SQLite`)
    }
  }

  // Create session manager
  const sm = new SessionManager(db)

  // Start HTTP server
  const server = createServer({ db, sm, token, port, hostname })
  activeServer = server

  // Write PID and port files
  writeFileSync(PID_FILE, String(process.pid))
  writeFileSync(PORT_FILE, String(port))

  return { port, token }
}

export async function stopDaemon(force: boolean = false): Promise<void> {
  // If not forced, check for active sessions
  if (!force && activeDb) {
    const stats = activeDb.getStats()
    if (stats.activeSessions > 0) {
      throw new Error(
        `Cannot stop: ${stats.activeSessions} active session(s). Use --force to stop anyway.`,
      )
    }
  }

  // Stop server
  if (activeServer) {
    activeServer.stop()
    activeServer = null
  }

  // Close database
  if (activeDb) {
    activeDb.close()
    activeDb = null
  }

  // Clean up PID/port files
  try { unlinkSync(PID_FILE) } catch {}
  try { unlinkSync(PORT_FILE) } catch {}
}

export function getDaemonStatus(): DaemonStatus | null {
  if (!existsSync(PID_FILE)) return null

  let pid = 0
  try { pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10) } catch { return null }

  // Check if process is actually running
  try {
    process.kill(pid, 0) // Signal 0 just checks existence
  } catch {
    // Process not running — clean up stale files
    try { unlinkSync(PID_FILE) } catch {}
    try { unlinkSync(PORT_FILE) } catch {}
    return null
  }

  const port = getPort()

  // Try to get stats from the running daemon's health endpoint
  // This is a best-effort; if daemon is not responding, report basic info
  return {
    pid,
    port,
    uptime: 0, // unknown from external process
    activeSessions: 0,
    totalSessions: 0,
    activeAgents: 0,
    version: '0.31.1',
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd apps/cli && pnpm typecheck
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/daemon/index.ts
git commit -m "feat(daemon): lifecycle management (start, stop, status)"
```

---

### Task 7: Daemon Binary Entry Point

**Files:**
- Create: `apps/cli/bin/daemon.ts`

**Interfaces:**
- Consumes: `startDaemon`, `stopDaemon`, `getDaemonStatus` from `daemon/index.ts`

- [ ] **Step 1: Write daemon binary entry**

```typescript
// apps/cli/bin/daemon.ts
#!/usr/bin/env bun

/**
 * Mipham Code Daemon — standalone background process.
 * Spawned by `mipham daemon start`.
 *
 * Usage: bun run bin/daemon.ts [--port PORT] [--bind HOST]
 */

import { startDaemon } from '../src/daemon/index'

const args = process.argv.slice(2)

// Parse --port and --bind from CLI args (passed by mipham CLI)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    process.env.MIPHAM_PORT = args[i + 1]!
  }
  if (args[i] === '--bind' && args[i + 1]) {
    process.env.MIPHAM_BIND = args[i + 1]!
  }
}

const { port } = await startDaemon()

console.log(`Daemon running on http://127.0.0.1:${port}`)
console.log(`PID: ${process.pid}`)

// Keep process alive
process.on('SIGTERM', async () => {
  const { stopDaemon } = await import('../src/daemon/index')
  await stopDaemon(true)
  process.exit(0)
})

process.on('SIGINT', async () => {
  const { stopDaemon } = await import('../src/daemon/index')
  await stopDaemon(true)
  process.exit(0)
})
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd apps/cli && pnpm typecheck
```
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/cli/bin/daemon.ts
git commit -m "feat(daemon): standalone daemon binary entry point"
```

---

### Task 8: CLI Daemon Commands

**Files:**
- Modify: `apps/cli/bin/mipham.ts`

**Interfaces:**
- Consumes: `startDaemon`, `stopDaemon`, `getDaemonStatus`, `getPort` from `daemon/index.ts`

- [ ] **Step 1: Add daemon subcommands to mipham.ts**

In `apps/cli/bin/mipham.ts`, add a new `runDaemonCLI` function and integrate it into `main()`.

```typescript
// Add this function before main()

async function runDaemonCLI(): Promise<boolean> {
  const args = process.argv.slice(2)
  if (args[0] !== 'daemon') return false

  const subcmd = args[1]

  // --no-daemon flag (checked in main)
  // All daemon commands dynamically import to keep startup fast
  const { startDaemon, stopDaemon, getDaemonStatus, getPort } =
    await import('../src/daemon/index')

  if (subcmd === 'start') {
    const status = getDaemonStatus()
    if (status) {
      console.log(`Daemon already running (PID: ${status.pid}, Port: ${status.port})`)
      process.exit(0)
    }

    console.log('Starting daemon...')
    // Spawn daemon as detached background process
    const { spawn } = await import('node:child_process')
    const daemonScript = new URL('./daemon.ts', import.meta.url).pathname
    const child = spawn('bun', ['run', daemonScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    })
    child.unref()

    // Wait briefly for daemon to start
    await new Promise(resolve => setTimeout(resolve, 1000))

    const newStatus = getDaemonStatus()
    if (newStatus) {
      console.log(`Daemon started (PID: ${newStatus.pid}, Port: ${newStatus.port})`)
    } else {
      console.log('Daemon started (PID unknown — check `mipham daemon status`)')
    }
    process.exit(0)
  }

  if (subcmd === 'stop') {
    const force = args.includes('--force')
    const status = getDaemonStatus()
    if (!status) {
      console.log('Daemon is not running.')
      process.exit(0)
    }
    try {
      // Send SIGTERM to daemon process
      process.kill(status.pid, 'SIGTERM')
      console.log(`Daemon stopped (PID: ${status.pid})`)
    } catch {
      console.log('Daemon is not running.')
    }
    process.exit(0)
  }

  if (subcmd === 'status') {
    const status = getDaemonStatus()
    if (status) {
      console.log(`Daemon: running`)
      console.log(`  PID:    ${status.pid}`)
      console.log(`  Port:   ${status.port}`)
      console.log(`  URL:    http://127.0.0.1:${status.port}`)
    } else {
      console.log(`Daemon: not running`)
    }
    process.exit(0)
  }

  if (subcmd === 'restart') {
    const status = getDaemonStatus()
    if (status) {
      try { process.kill(status.pid, 'SIGTERM') } catch {}
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    // Re-spawn daemon
    const { spawn } = await import('node:child_process')
    const daemonScript = new URL('./daemon.ts', import.meta.url).pathname
    const child = spawn('bun', ['run', daemonScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    })
    child.unref()
    await new Promise(resolve => setTimeout(resolve, 1000))
    console.log('Daemon restarted.')
    process.exit(0)
  }

  // Unknown subcommand
  console.error(`Unknown daemon command: mipham daemon ${subcmd}`)
  console.error('Usage: mipham daemon start|stop|status|restart')
  process.exit(1)
}
```

- [ ] **Step 2: Integrate daemon CLI into main()**

In `main()`, add daemon CLI handling after `runUpdate()` and before `runPluginCLI()`:

```typescript
  // ── Update / upgrade ──────────────────────────────────────────────────────
  const handledUpdate = await runUpdate()
  if (handledUpdate) return

  // ── Daemon commands ───────────────────────────────────────────────────────
  const handledDaemon = await runDaemonCLI()
  if (handledDaemon) return
```

Also add `'daemon'` to the `KNOWN_COMMANDS` array (for typo suggestions).

- [ ] **Step 3: Update KNOWN_COMMANDS**

Change:
```typescript
const KNOWN_COMMANDS = ['update', 'upgrade', 'plugin', 'workflow', 'help']
```
To:
```typescript
const KNOWN_COMMANDS = ['update', 'upgrade', 'plugin', 'workflow', 'daemon', 'help']
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd apps/cli && pnpm typecheck
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/cli/bin/mipham.ts
git commit -m "feat(daemon): CLI subcommands (start, stop, status, restart)"
```

---

### Task 9: Integration Verification

- [ ] **Step 1: Run all daemon tests**

```bash
cd apps/cli && npx vitest run test/daemon/
```
Expected: ALL TESTS PASS

- [ ] **Step 2: Run full test suite (no regressions)**

```bash
cd apps/cli && npx vitest run
```
Expected: ALL 1020+ TESTS PASS

- [ ] **Step 3: Run typecheck**

```bash
cd apps/cli && pnpm typecheck
```
Expected: PASS

- [ ] **Step 4: Run format check**

```bash
pnpm format:check
```
Expected: PASS

- [ ] **Step 5: Final commit**

```bash
git commit --allow-empty -m "chore(daemon): Phase 1 complete — daemon core infrastructure"
```

---

## Phase 1 Deliverable Summary

After Task 9, the daemon core is operational:

- `mipham daemon start` — starts HTTP+WebSocket daemon on port 45671
- `mipham daemon status` — shows daemon PID, port, URL
- `mipham daemon stop` — stops daemon (blocks if active sessions)
- `mipham daemon restart` — restarts daemon
- `mipham --no-daemon` — runs in old single-process mode
- REST API: `GET /health`, `POST/GET/DELETE /sessions`, `GET /sessions/:id/messages`
- All state persisted to SQLite at `~/.mipham/daemon.db`

**Next phases build on this:**
- Phase 2: Session Workers + Engine integration + `mipham attach`
- Phase 3: Agent communication system
- Phase 4: Goals + Schedules
- Phase 5: External API auth + rate limiting + docs
