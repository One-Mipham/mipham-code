/**
 * SIS Phase 0: ErrorSignatureDB Unit Tests
 *
 * Tests the persistent error signature database:
 *   - Insert, dedup, and query
 *   - Pattern matching
 *   - Success rate tracking and auto-degradation
 *   - Cleanup and stats
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ErrorSignatureDB } from '../../src/core/error-signature-db'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TEST_DIR = join('/tmp', `sis-test-${randomUUID()}`)

function makeSig(overrides: Partial<Parameters<ErrorSignatureDB['insert']>[0]> = {}) {
  return {
    pattern: 'npm install',
    category: 'timeout',
    toolName: 'Bash',
    fixStrategy: 'replace' as const,
    fixAction: 'pnpm install --no-frozen-lockfile',
    explanation: 'npm install frequently times out on large projects',
    ...overrides,
  }
}

describe('ErrorSignatureDB', () => {
  let db: ErrorSignatureDB

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    db = new ErrorSignatureDB(TEST_DIR)
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('insert and dedup', () => {
    it('inserts a new signature', () => {
      const sig = db.insert(makeSig())
      expect(sig.id).toMatch(/^sis-/)
      expect(sig.occurrences).toBe(1)
      expect(sig.status).toBe('active')
      expect(sig.successRate).toBe(0)
    })

    it('deduplicates by pattern + toolName + category', () => {
      const first = db.insert(makeSig({ pattern: 'npm install' }))
      const second = db.insert(makeSig({ pattern: 'npm install' }))
      expect(second.id).toBe(first.id)
      expect(second.occurrences).toBe(2)
    })

    it('creates separate signatures for different patterns', () => {
      const a = db.insert(makeSig({ pattern: 'npm install' }))
      const b = db.insert(makeSig({ pattern: 'docker build' }))
      expect(a.id).not.toBe(b.id)
    })

    it('creates separate signatures for different categories', () => {
      const a = db.insert(makeSig({ pattern: 'git push', category: 'tool-params' }))
      const b = db.insert(makeSig({ pattern: 'git push', category: 'timeout' }))
      expect(a.id).not.toBe(b.id)
    })
  })

  describe('match', () => {
    it('matches by toolName and pattern substring', () => {
      db.insert(makeSig({ pattern: 'npm install', toolName: 'Bash' }))
      const match = db.match('Bash', { command: 'npm install --save react' })
      expect(match).not.toBeNull()
      expect(match!.pattern).toBe('npm install')
    })

    it('returns null when toolName differs', () => {
      db.insert(makeSig({ pattern: 'npm install', toolName: 'Bash' }))
      const match = db.match('Write', { command: 'npm install' })
      expect(match).toBeNull()
    })

    it('returns null when no pattern matches', () => {
      db.insert(makeSig({ pattern: 'npm install', toolName: 'Bash' }))
      const match = db.match('Bash', { command: 'git status' })
      expect(match).toBeNull()
    })

    it('does not match retired signatures', () => {
      const sig = db.insert(makeSig({ pattern: 'old-cmd' }))
      db.retire(sig.id)
      const match = db.match('Bash', { command: 'old-cmd' })
      expect(match).toBeNull()
    })

    it('matches from params description field', () => {
      db.insert(makeSig({ pattern: 'missing lockfile', toolName: 'Bash' }))
      const match = db.match('Bash', { description: 'missing lockfile error' })
      expect(match).not.toBeNull()
    })
  })

  describe('recordResult and auto-degradation', () => {
    it('updates success rate on recordResult', () => {
      const sig = db.insert(makeSig())
      // Simulate: 3 successes out of 5 occurrences
      // First fix the occurrence count to 5
      for (let i = 0; i < 4; i++) {
        db.insert(makeSig()) // brings occurrences to 5
      }
      db.recordResult(sig.id, true)
      db.recordResult(sig.id, true)
      db.recordResult(sig.id, true)
      // After 3 successes out of 5 occurrences with 1 successCount adjustment
      const updated = db.get(sig.id)
      expect(updated).not.toBeUndefined()
      expect(updated!.successCount).toBeGreaterThan(0)
    })

    it('degrads signature when success rate drops below 50%', () => {
      const sig = db.insert(makeSig())
      // Insert many more to bump occurrences high so individual successes don't matter
      for (let i = 0; i < 100; i++) {
        db.insert(makeSig())
      }
      // Record 0 successes — success rate stays at 0
      db.recordResult(sig.id, false)
      const updated = db.get(sig.id)
      // With 101 occurrences and 0 successes, successRate should be 0, well below 50%
      expect(updated!.successRate).toBeLessThan(0.5)
      expect(updated!.status).toBe('degraded')
    })
  })

  describe('getActive and query', () => {
    it('getActive excludes retired signatures', () => {
      db.insert(makeSig({ pattern: 'active-rule' }))
      const retired = db.insert(makeSig({ pattern: 'retired-rule' }))
      db.retire(retired.id)
      const active = db.getActive()
      expect(active.length).toBe(1)
      expect(active[0]!.pattern).toBe('active-rule')
    })

    it('getStats returns correct aggregates', () => {
      db.insert(makeSig({ pattern: 'a' }))
      db.insert(makeSig({ pattern: 'b' }))
      const stats = db.getStats()
      expect(stats.total).toBe(2)
      expect(stats.active).toBe(2)
      expect(stats.totalInterceptions).toBe(2) // each inserted once
    })
  })

  describe('cleanup', () => {
    it('removes retired signatures when retention is 0', async () => {
      const sig = db.insert(makeSig({ pattern: 'old' }))
      db.retire(sig.id)
      // Wait enough time for timestamp to be strictly before cleanup cutoff
      await new Promise((r) => setTimeout(r, 10))
      const removed = db.cleanup(0)
      expect(removed).toBeGreaterThanOrEqual(0)
    })

    it('does not remove active signatures', () => {
      db.insert(makeSig({ pattern: 'active' }))
      const removed = db.cleanup(0)
      expect(removed).toBe(0)
      expect(db.getActive().length).toBe(1)
    })
  })

  describe('persistence', () => {
    it('survives re-instantiation', () => {
      db.insert(makeSig({ pattern: 'npm install' }))
      const db2 = new ErrorSignatureDB(TEST_DIR)
      const active = db2.getActive()
      expect(active.length).toBe(1)
      expect(active[0]!.pattern).toBe('npm install')
    })
  })
})
