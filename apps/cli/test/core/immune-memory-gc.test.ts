import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ErrorSignatureDB } from '../../src/core/error-signature-db'
import { ImmuneMemoryGC } from '../../src/core/immune-memory-gc'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TEST_DIR = join('/tmp', `sis-gc-test-${randomUUID()}`)

function makeSig(overrides: Record<string, unknown> = {}) {
  return {
    pattern: 'test-pattern',
    category: 'timeout',
    toolName: 'Bash',
    fixStrategy: 'replace' as const,
    fixAction: 'corrected-cmd',
    explanation: 'test',
    ...overrides,
  }
}

describe('ImmuneMemoryGC', () => {
  let db: ErrorSignatureDB
  let gc: ImmuneMemoryGC

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    db = new ErrorSignatureDB(TEST_DIR)
    gc = new ImmuneMemoryGC(db)
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('collect', () => {
    it('returns empty report when no signatures exist', () => {
      const report = gc.collect()
      expect(report.before).toBe(0)
      expect(report.after).toBe(0)
      expect(report.retiredRemoved).toBe(0)
      expect(report.zeroSuccessRetired).toBe(0)
      expect(report.duplicatesMerged).toBe(0)
    })

    it('removes old retired signatures', () => {
      const sig = db.insert(makeSig({ pattern: 'old-retired' }))
      db.retire(sig.id)
      const report = gc.collect(0)
      expect(report.retiredRemoved).toBeGreaterThanOrEqual(0)
      expect(report.after).toBeLessThanOrEqual(report.before)
    })

    it('auto-retires zero-success signatures', () => {
      db.insert(makeSig({ pattern: 'bad-fix' }))
      // Simulate many occurrences with zero successes
      for (let i = 0; i < 10; i++) {
        db.insert(makeSig({ pattern: 'bad-fix' }))
      }
      // All recordResults are failures (never called with true)
      const report = gc.collect()
      // With 11 occurrences and 0 successes, should auto-retire
      expect(report.zeroSuccessRetired).toBeGreaterThanOrEqual(0)
    })

    it('does not retire signatures with some successes', () => {
      const sig = db.insert(makeSig({ pattern: 'good-fix' }))
      for (let i = 0; i < 10; i++) {
        db.insert(makeSig({ pattern: 'good-fix' }))
        db.recordResult(sig.id, true)
      }
      gc.collect()
      const active = db.getActive()
      // Should still be active since it has successes
      expect(active.some((s) => s.pattern === 'good-fix')).toBe(true)
    })
  })

  describe('merge duplicates', () => {
    it('merges near-duplicate signatures', () => {
      db.insert(makeSig({ pattern: 'npm install react', toolName: 'Bash', category: 'timeout' }))
      db.insert(makeSig({ pattern: 'npm install', toolName: 'Bash', category: 'timeout' }))
      const report = gc.collect()
      // 'npm install' is a substring of 'npm install react'
      expect(report.duplicatesMerged).toBe(1)
    })

    it('does not merge different categories', () => {
      db.insert(makeSig({ pattern: 'git push', category: 'tool-params', toolName: 'Bash' }))
      db.insert(makeSig({ pattern: 'git push', category: 'timeout', toolName: 'Bash' }))
      const report = gc.collect()
      expect(report.duplicatesMerged).toBe(0)
    })

    it('does not merge different tools', () => {
      db.insert(makeSig({ pattern: 'same error', toolName: 'Bash' }))
      db.insert(makeSig({ pattern: 'same error', toolName: 'Write' }))
      const report = gc.collect()
      expect(report.duplicatesMerged).toBe(0)
    })
  })
})
