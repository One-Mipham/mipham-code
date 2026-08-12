import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ErrorSignatureDB } from '../../src/core/error-signature-db'
import { AutoCorrector } from '../../src/core/auto-corrector'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TEST_DIR = join('/tmp', `sis-ac-test-${randomUUID()}`)

describe('AutoCorrector', () => {
  let db: ErrorSignatureDB
  let corrector: AutoCorrector

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    db = new ErrorSignatureDB(TEST_DIR)
    corrector = new AutoCorrector(db)
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('unknown errors', () => {
    it('records new error signatures for unknown errors', () => {
      const result = corrector.analyze(
        'Bash',
        { command: 'some-new-cmd' },
        'command not found: some-new-cmd',
      )
      expect(result.corrected).toBe(false)
      expect(result.action).toBe('record-only')
      expect(result.newSignatureId).toBeDefined()

      // Verify it was persisted
      const sig = db.get(result.newSignatureId!)
      expect(sig).toBeDefined()
      expect(sig!.category).toBe('semantic')
    })

    it('extracts stable patterns from dynamic errors', () => {
      const result = corrector.analyze(
        'Bash',
        { command: 'cat /tmp/file-12345.txt' },
        "ENOENT: no such file or directory, open '/tmp/file-12345.txt'",
      )
      expect(result.newSignatureId).toBeDefined()
      const sig = db.get(result.newSignatureId!)
      // Pattern should have path replaced with <path>
      expect(sig!.pattern).not.toContain('12345')
    })

    it('categorizes timeout errors correctly', () => {
      const result = corrector.analyze(
        'Bash',
        { command: 'npm install' },
        'ETIMEDOUT: operation timed out',
      )
      const sig = db.get(result.newSignatureId!)
      expect(sig!.category).toBe('timeout')
    })
  })

  describe('known errors — high confidence auto-retry', () => {
    it('auto-corrects when a high-confidence replace fix exists', () => {
      db.insert({
        pattern: 'npm install',
        category: 'timeout',
        toolName: 'Bash',
        fixStrategy: 'replace',
        fixAction: 'pnpm install --no-frozen-lockfile',
        explanation: 'npm install frequently times out — use pnpm',
      })
      // Simulate high success rate
      const sig = db.getActive()[0]!
      // Manually set high success
      for (let i = 0; i < 10; i++) {
        db.recordResult(sig.id, true)
      }

      const result = corrector.analyze('Bash', { command: 'npm install' }, 'ETIMEDOUT')
      expect(result.action).toBe('retry')
      expect(result.corrected).toBe(true)
      expect(result.correctedParams).toEqual({ command: 'pnpm install --no-frozen-lockfile' })
    })
  })

  describe('known errors — low confidence suggest', () => {
    it('suggests but does not auto-apply for low-confidence matches', () => {
      db.insert({
        pattern: 'docker build',
        category: 'timeout',
        toolName: 'Bash',
        fixStrategy: 'replace',
        fixAction: 'docker build --network=host',
        explanation: 'docker build may timeout without host network',
      })
      // No success records — confidence is 0

      const result = corrector.analyze('Bash', { command: 'docker build .' }, 'timeout')
      expect(result.action).toBe('suggest')
      expect(result.corrected).toBe(false)
      expect(result.suggestion).toContain('SIS 建议')
    })
  })

  describe('max retries', () => {
    it('stops suggesting after max retries', () => {
      db.insert({
        pattern: 'flake',
        category: 'semantic',
        toolName: 'Bash',
        fixStrategy: 'replace',
        fixAction: 'retry-cmd',
        explanation: 'Flaky command',
      })
      // Give it high confidence
      const sig = db.getActive()[0]!
      for (let i = 0; i < 10; i++) db.recordResult(sig.id, true)

      const result = corrector.analyze('Bash', { command: 'flake' }, 'error', 1)
      expect(result.action).toBe('record-only')
    })
  })
})
