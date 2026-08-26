import { describe, it, expect, afterEach } from 'vitest'
import {
  createAutoloopJournal,
  readAutoloopJournal,
  logAutoloopIteration,
  completeAutoloopJournal,
  listActiveAutoloops,
  getAutoloopStatus,
  recordLoopTokens,
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
})
