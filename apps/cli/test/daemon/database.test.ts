// apps/cli/test/daemon/database.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DaemonDatabase } from '../../src/daemon/database'
import { unlinkSync } from 'node:fs'

const TEST_DB = '/tmp/mipham-daemon-test.db'

function cleanDb() {
  try {
    unlinkSync(TEST_DB)
  } catch {}
  try {
    unlinkSync(TEST_DB + '-wal')
  } catch {}
  try {
    unlinkSync(TEST_DB + '-shm')
  } catch {}
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
    expect(active.every((s) => s.status === 'active')).toBe(true)
  })

  it('saves and retrieves messages', () => {
    const session = db.createSession({
      name: 'msg-test',
      cwd: '/tmp',
      provider: 'openai',
      model: 'gpt-5',
    })
    db.saveMessage(session.id, 'user', JSON.stringify({ role: 'user', content: 'hello' }))
    db.saveMessage(
      session.id,
      'assistant',
      JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'hi!' }] }),
    )

    const messages = db.getMessages(session.id)
    expect(messages.length).toBe(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[1]!.role).toBe('assistant')
  })

  it('respects message limit', () => {
    const session = db.createSession({
      name: 'limit-test',
      cwd: '/tmp',
      provider: 'openai',
      model: 'gpt-5',
    })
    for (let i = 0; i < 10; i++) {
      db.saveMessage(session.id, 'user', JSON.stringify({ role: 'user', content: `msg-${i}` }))
    }
    const messages = db.getMessages(session.id, 5)
    expect(messages.length).toBe(5)
  })

  it('creates and lists agents', () => {
    const session = db.createSession({
      name: 'agent-test',
      cwd: '/tmp',
      provider: 'anthropic',
      model: 'claude',
    })
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
    const session = db.createSession({
      name: 'goal-test',
      cwd: '/tmp',
      provider: 'openai',
      model: 'gpt-5',
    })
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
    const session = db.createSession({
      name: 'sched-test',
      cwd: '/tmp',
      provider: 'openai',
      model: 'gpt-5',
    })
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

  it('migrates JSONL sessions to SQLite', async () => {
    // Create a fake JSONL session file
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const sessionsDir = join(process.env.HOME || '/tmp', '.mipham', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const oldSession = {
      metadata: {
        name: 'old-session',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        provider: 'openai',
        model: 'gpt-4',
        messageCount: 10,
        cwd: '/tmp',
      },
      messages: [{ role: 'user', content: 'test' }],
    }
    writeFileSync(join(sessionsDir, 'old-session.jsonl'), JSON.stringify(oldSession))

    const count = db.migrateFromJsonl()
    expect(count).toBeGreaterThanOrEqual(1)

    // Clean up
    try {
      unlinkSync(join(sessionsDir, 'old-session.jsonl'))
    } catch {}
  })
})
