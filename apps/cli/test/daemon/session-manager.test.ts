import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SessionManager } from '../../src/daemon/session-manager'
import { DaemonDatabase } from '../../src/daemon/database'
import { unlinkSync } from 'node:fs'

const TEST_DB = '/tmp/mipham-sm-test.db'

describe('SessionManager', () => {
  let db: DaemonDatabase
  let sm: SessionManager

  beforeAll(() => {
    try {
      unlinkSync(TEST_DB)
    } catch {}
    try {
      unlinkSync(TEST_DB + '-wal')
    } catch {}
    try {
      unlinkSync(TEST_DB + '-shm')
    } catch {}
    db = new DaemonDatabase(TEST_DB)
    db.init()
    sm = new SessionManager(db)
  })

  afterAll(() => {
    db.close()
    try {
      unlinkSync(TEST_DB)
    } catch {}
  })

  it('creates a session with defaults', () => {
    const session = sm.createSession('my-session', '/tmp/project', 'anthropic', 'claude-sonnet-5')
    expect(session.id).toBeDefined()
    expect(session.name).toBe('my-session')
    expect(session.status).toBe('active')
    expect(session.cwd).toBe('/tmp/project')
  })

  it('returns active session count', () => {
    // Create a known number of sessions so this test is self-contained
    const before = sm.getActiveCount()
    sm.createSession('count-1', '/tmp/a', 'openai', 'gpt-5')
    sm.createSession('count-2', '/tmp/b', 'openai', 'gpt-5')
    expect(sm.getActiveCount()).toBe(before + 2)
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
    expect(active.every((s) => s.status === 'active')).toBe(true)
  })

  it('notifies onClose callback when session is closed', () => {
    let closedId = ''
    sm.onSessionClosed((id) => {
      closedId = id
    })

    const s = sm.createSession('cb-test', '/tmp', 'openai', 'gpt-5')
    sm.closeSession(s.id)
    expect(closedId).toBe(s.id)
  })

  it('getOrCreateByExternalUser 复用同名非 closed 会话', () => {
    const db = new DaemonDatabase(':memory:')
    db.init()
    const sm = new SessionManager(db)
    const s1 = sm.getOrCreateByExternalUser('feishu', 'ou_1', '/tmp', 'anthropic', 'claude')
    const s2 = sm.getOrCreateByExternalUser('feishu', 'ou_1', '/tmp', 'anthropic', 'claude')
    expect(s2.id).toBe(s1.id)
    expect(s2.name).toBe('feishu-ou_1')
    db.close()
  })

  it('getOrCreateByExternalUser 为不同 channel/userId 建独立会话', () => {
    const db = new DaemonDatabase(':memory:')
    db.init()
    const sm = new SessionManager(db)
    const a = sm.getOrCreateByExternalUser('feishu', 'ou_a', '/tmp', 'anthropic', 'claude')
    const b = sm.getOrCreateByExternalUser('telegram', '111', '/tmp', 'anthropic', 'claude')
    expect(b.id).not.toBe(a.id)
    expect(b.name).toBe('telegram-111')
    db.close()
  })
})
