import { describe, it, expect, afterEach } from 'vitest'
import {
  createAutoloopJournal,
  readAutoloopJournal,
  logAutoloopIteration,
  completeAutoloopJournal,
  listActiveAutoloops,
  getAutoloopStatus,
  recordLoopTokens,
  recordLoopTurn,
  NO_VISIBLE_OUTPUT,
} from '../../src/commands/autoloop-journal.js'

const SESSION_ID = 'test-autoloop-001'

describe('AutoloopJournal', () => {
  afterEach(() => {
    // Clean up after each test
    completeAutoloopJournal(SESSION_ID, 'stopped')
  })

  it('creates a journal with correct initial state', () => {
    const journal = createAutoloopJournal(SESSION_ID, 'fix all bugs')
    expect(journal.sessionId).toBe(SESSION_ID)
    expect(journal.prompt).toBe('fix all bugs')
    expect(journal.status).toBe('active')
    expect(journal.iterations).toBe(0)
    expect(journal.logs).toEqual([])
  })

  it('reads back a journal', () => {
    createAutoloopJournal(SESSION_ID, 'deploy the app')
    const journal = readAutoloopJournal(SESSION_ID)
    expect(journal).not.toBeNull()
    expect(journal!.prompt).toBe('deploy the app')
  })

  it('returns null for non-existent journal', () => {
    const journal = readAutoloopJournal('nonexistent-id')
    expect(journal).toBeNull()
  })

  it('logs iterations and increments count', () => {
    createAutoloopJournal(SESSION_ID, 'monitor CI')
    logAutoloopIteration(SESSION_ID, 'checked build status — green')
    logAutoloopIteration(SESSION_ID, 'ran tests — 295 passed')

    const journal = readAutoloopJournal(SESSION_ID)!
    expect(journal.iterations).toBe(2)
    expect(journal.logs).toHaveLength(2)
    expect(journal.logs[0]).toContain('green')
    expect(journal.logs[1]).toContain('295 passed')
  })

  it('completes a journal', () => {
    createAutoloopJournal(SESSION_ID, 'weekly report')
    logAutoloopIteration(SESSION_ID, 'generated report')
    completeAutoloopJournal(SESSION_ID, 'completed')

    const journal = readAutoloopJournal(SESSION_ID)!
    expect(journal.status).toBe('completed')
  })

  it('lists only active autoloops', () => {
    createAutoloopJournal('autoloop-active', 'active task')
    createAutoloopJournal('autoloop-done', 'done task')
    completeAutoloopJournal('autoloop-done', 'completed')

    const active = listActiveAutoloops()
    const activeIds = active.map((j) => j.sessionId)
    expect(activeIds).toContain('autoloop-active')
    expect(activeIds).not.toContain('autoloop-done')

    // cleanup
    completeAutoloopJournal('autoloop-active', 'stopped')
  })

  it('getAutoloopStatus returns formatted status', () => {
    createAutoloopJournal(SESSION_ID, 'build pipeline')
    logAutoloopIteration(SESSION_ID, 'deploy step done')
    const status = getAutoloopStatus(SESSION_ID)
    expect(status).toContain('build pipeline')
    expect(status).toContain('Running')
    expect(status).toContain('deploy step done')
  })

  it('records startTokens at creation and accumulates totalTokens via recordLoopTokens', () => {
    const j = createAutoloopJournal('s1', 'monitor', 1000)
    expect(j.startTokens).toBe(1000)
    expect(j.totalTokens).toBe(0)
    recordLoopTokens('s1', 250)
    recordLoopTokens('s1', 300)
    const after = readAutoloopJournal('s1')!
    expect(after.totalTokens).toBe(550)
  })

  it('recordLoopTurn logs an iteration and accumulates the token delta', () => {
    createAutoloopJournal('s-loop', 'task', 1000)
    recordLoopTurn('s-loop', 'done', 50)
    const journal = readAutoloopJournal('s-loop')!
    expect(journal.iterations).toBe(1)
    expect(journal.totalTokens).toBe(50)
  })

  it('recordLoopTurn stops the loop at maxIterations and no-ops further accounting', () => {
    const j = createAutoloopJournal('s-max', 'task', 0)
    for (let i = 0; i < j.maxIterations; i++) {
      recordLoopTurn('s-max', 'iter', 0)
    }
    const stopped = readAutoloopJournal('s-max')!
    expect(stopped.status).toBe('stopped')
    expect(stopped.iterations).toBe(100)

    // status guard: a stray turn after the guard fired must not increment further
    recordLoopTurn('s-max', 'x', 0)
    const after = readAutoloopJournal('s-max')!
    expect(after.iterations).toBe(100)
  })
})

/**
 * An iteration that produced no visible text must not look like an iteration
 * that was never recorded.
 *
 * `app.tsx` hands `recordLoopTurn` the turn's `assistantContent`, which only
 * accumulates `type === 'text'` chunks — a turn of tool calls, or of thinking
 * only (hidden by default), arrives as `''`. Rendered as `#N: ` that row has
 * the same shape as "nothing was written", which is the one thing `/loop
 * status` must not conflate.
 */
describe('AutoloopJournal — iterations with no visible output', () => {
  const cleanup = (id: string): void => completeAutoloopJournal(id, 'stopped')

  it('renders an explicit row instead of a trailing blank', () => {
    createAutoloopJournal('s-blank', 'monitor CI', 0)
    recordLoopTurn('s-blank', '', 10)

    const row = readAutoloopJournal('s-blank')!.logs[0]!
    expect(row).toContain(NO_VISIBLE_OUTPUT)
    // the user-visible landing point, not just the file
    expect(getAutoloopStatus('s-blank')).toContain(NO_VISIBLE_OUTPUT)
    cleanup('s-blank')
  })

  it('treats whitespace-only output as no output, and keeps real text verbatim', () => {
    createAutoloopJournal('s-ws', 'monitor CI', 0)
    logAutoloopIteration('s-ws', '   \n ')
    logAutoloopIteration('s-ws', '  CI green  ')

    const logs = readAutoloopJournal('s-ws')!.logs
    expect(logs[0]).toContain(NO_VISIBLE_OUTPUT)
    expect(logs[1]).toContain('CI green')
    expect(logs[1]).not.toContain(NO_VISIBLE_OUTPUT)
    cleanup('s-ws')
  })
})
