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
