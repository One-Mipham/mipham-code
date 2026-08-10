// apps/cli/src/daemon/database.ts
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  DaemonSession,
  DaemonAgent,
  DaemonGoal,
  DaemonSchedule,
  MessageRecord,
  CreateSessionInput,
  SessionStatus,
} from './types'

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
      id,
      name: input.name,
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      turnCount: 0,
      tokenIn: 0,
      tokenOut: 0,
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
      ? (this.db.query(sql).all(status) as Record<string, unknown>[])
      : (this.db.query(sql).all() as Record<string, unknown>[])
    return rows.map((r) => this.rowToSession(r))
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
    return rows.reverse().map((r) => ({
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
      [
        agent.id,
        agent.sessionId,
        agent.parentId,
        agent.agentType,
        agent.description,
        agent.status,
        agent.kind,
        agent.worktree,
        agent.branch,
        agent.prUrl,
        agent.createdAt,
        agent.completedAt,
        agent.result,
        agent.error,
      ],
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
      ? (this.db.query(sql).all(sessionId) as Record<string, unknown>[])
      : (this.db.query(sql).all() as Record<string, unknown>[])
    return rows.map((r) => this.rowToAgent(r))
  }

  updateAgentStatus(id: string, status: string, result?: string, error?: string): void {
    const completedAt =
      status === 'completed' || status === 'failed' ? new Date().toISOString() : null
    this.db.run(
      `UPDATE agents SET status = ?, result = ?, error = ?, completed_at = ? WHERE id = ?`,
      [status, result ?? null, error ?? null, completedAt, id],
    )
  }

  // ── Goals ──────────────────────────────────────────────────

  createGoal(goal: Omit<DaemonGoal, 'id'>): number {
    const result = this.db.run(
      `INSERT INTO goals (session_id, description, status, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        goal.sessionId,
        goal.description,
        goal.status,
        goal.progress ? JSON.stringify(goal.progress) : null,
        goal.createdAt,
        goal.updatedAt,
      ],
    )
    return Number(result.lastInsertRowid)
  }

  getGoals(sessionId: string): DaemonGoal[] {
    const rows = this.db
      .query('SELECT * FROM goals WHERE session_id = ? ORDER BY id')
      .all(sessionId) as Record<string, unknown>[]
    return rows.map((r) => ({
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

    if (updates.status !== undefined) {
      sets.push('status = ?')
      vals.push(updates.status)
    }
    if (updates.description !== undefined) {
      sets.push('description = ?')
      vals.push(updates.description)
    }
    if (updates.progress !== undefined) {
      sets.push('progress = ?')
      vals.push(updates.progress ? JSON.stringify(updates.progress) : null)
    }

    vals.push(id)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.db.run(`UPDATE goals SET ${sets.join(', ')} WHERE id = ?`, vals as any)
  }

  // ── Schedules ──────────────────────────────────────────────

  createSchedule(schedule: Omit<DaemonSchedule, 'id'>): number {
    const result = this.db.run(
      `INSERT INTO schedules (session_id, cron_expr, prompt, enabled, last_fired, next_fire) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        schedule.sessionId,
        schedule.cronExpr,
        schedule.prompt,
        schedule.enabled ? 1 : 0,
        schedule.lastFired,
        schedule.nextFire,
      ],
    )
    return Number(result.lastInsertRowid)
  }

  getSchedules(sessionId: string): DaemonSchedule[] {
    const rows = this.db
      .query('SELECT * FROM schedules WHERE session_id = ?')
      .all(sessionId) as Record<string, unknown>[]
    return rows.map((r) => this.rowToSchedule(r))
  }

  deleteSchedule(id: number): void {
    this.db.run('DELETE FROM schedules WHERE id = ?', [id])
  }

  getDueSchedules(): DaemonSchedule[] {
    const now = new Date().toISOString()
    const rows = this.db
      .query('SELECT * FROM schedules WHERE enabled = 1 AND next_fire <= ?')
      .all(now) as Record<string, unknown>[]
    return rows.map((r) => this.rowToSchedule(r))
  }

  // ── Migration ──────────────────────────────────────────────

  migrateFromJsonl(): number {
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
    const activeSessions = (
      this.db.query("SELECT COUNT(*) as c FROM sessions WHERE status != 'closed'").get() as {
        c: number
      }
    ).c
    const totalSessions = (
      this.db.query('SELECT COUNT(*) as c FROM sessions').get() as { c: number }
    ).c
    const activeAgents = (
      this.db.query("SELECT COUNT(*) as c FROM agents WHERE status = 'running'").get() as {
        c: number
      }
    ).c
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
