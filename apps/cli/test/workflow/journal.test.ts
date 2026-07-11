import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  createJournal,
  appendJournal,
  loadJournal,
  listRuns,
  loadScript,
} from '../../src/workflow/journal'

const WORKFLOW_DIR = join(homedir(), '.mipham', 'workflows')
const TEST_RUN_ID = 'test-run-journal-001'

describe('Journal', () => {
  beforeEach(() => {
    // Clean up test run before each test
    const testDir = join(WORKFLOW_DIR, TEST_RUN_ID)
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
    mkdirSync(WORKFLOW_DIR, { recursive: true })
  })

  afterEach(() => {
    const testDir = join(WORKFLOW_DIR, TEST_RUN_ID)
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('creates a journal directory with script, journal, and state files', () => {
    const script = 'agent("hello")'
    const dir = createJournal(TEST_RUN_ID, script)

    expect(existsSync(dir)).toBe(true)
    expect(existsSync(join(dir, 'script.js'))).toBe(true)
    expect(existsSync(join(dir, 'journal.jsonl'))).toBe(true)
    expect(existsSync(join(dir, 'state.json'))).toBe(true)
  })

  it('appends journal entries with incrementing sequence numbers', () => {
    createJournal(TEST_RUN_ID, 'test script')

    const seq1 = appendJournal(TEST_RUN_ID, { type: 'agent', prompt: 'task 1', result: 'ok' })
    const seq2 = appendJournal(TEST_RUN_ID, { type: 'phase', message: 'Phase 2' })
    const seq3 = appendJournal(TEST_RUN_ID, { type: 'log', message: 'done' })

    expect(seq1).toBe(1)
    expect(seq2).toBe(2)
    expect(seq3).toBe(3)
  })

  it('loads all journal entries back in order', () => {
    createJournal(TEST_RUN_ID, 'test script')

    appendJournal(TEST_RUN_ID, { type: 'agent', prompt: 'task 1', result: 'ok' })
    appendJournal(TEST_RUN_ID, { type: 'phase', message: 'Phase 2' })
    appendJournal(TEST_RUN_ID, { type: 'log', message: 'done' })

    const entries = loadJournal(TEST_RUN_ID)
    expect(entries).toHaveLength(3)
    expect(entries[0]!.seq).toBe(1)
    expect(entries[0]!.type).toBe('agent')
    expect(entries[1]!.seq).toBe(2)
    expect(entries[1]!.type).toBe('phase')
    expect(entries[2]!.seq).toBe(3)
    expect(entries[2]!.type).toBe('log')
  })

  it('returns empty array for non-existent run', () => {
    const entries = loadJournal('nonexistent-run-id')
    expect(entries).toEqual([])
  })

  it('stores and retrieves the script', () => {
    const script = 'agent("hello world")'
    createJournal(TEST_RUN_ID, script)

    const loaded = loadScript(TEST_RUN_ID)
    expect(loaded).toBe(script)
  })

  it('lists all run IDs', () => {
    createJournal(TEST_RUN_ID, 'test')

    const runs = listRuns()
    expect(runs).toContain(TEST_RUN_ID)
  })
})
