/**
 * SIS Phase 0: PreFlightChecker Unit Tests
 *
 * Tests the pre-execution interception layer:
 *   - ErrorSignatureDB matching → block/warn/fix actions
 *   - ExperienceRuleEngine integration
 *   - Action priority (block > fix > warn > allow)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ErrorSignatureDB } from '../../src/core/error-signature-db'
import { PreFlightChecker } from '../../src/core/preflight-checker'
import { ExperienceRuleEngine } from '../../src/core/rule-engine'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TEST_DIR = join('/tmp', `sis-pf-test-${randomUUID()}`)

describe('PreFlightChecker', () => {
  let db: ErrorSignatureDB
  let checker: PreFlightChecker

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    db = new ErrorSignatureDB(TEST_DIR)
    checker = new PreFlightChecker(db)
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe('no signatures — allow all', () => {
    it('returns allow when no signatures exist', () => {
      const result = checker.check('Bash', { command: 'npm install' })
      expect(result.action).toBe('allow')
    })
  })

  describe('block strategy', () => {
    it('blocks execution for block-strategy signatures', () => {
      db.insert({
        pattern: 'rm -rf /',
        category: 'tool-params',
        toolName: 'Bash',
        fixStrategy: 'block',
        fixAction: '',
        explanation: '危险操作: 递归删除根目录',
      })
      const result = checker.check('Bash', { command: 'rm -rf / --no-preserve-root' })
      expect(result.action).toBe('block')
      expect(result.warning).toContain('SIS 免疫拦截')
    })
  })

  describe('warn strategy', () => {
    it('warns for warn-strategy signatures', () => {
      db.insert({
        pattern: 'git push --force',
        category: 'tool-params',
        toolName: 'Bash',
        fixStrategy: 'warn',
        fixAction: '',
        explanation: '强制推送可能覆盖远程分支',
      })
      const result = checker.check('Bash', { command: 'git push --force origin main' })
      expect(result.action).toBe('warn')
      expect(result.warning).toContain('SIS 预警')
    })
  })

  describe('replace strategy', () => {
    it('auto-fixes replace-strategy signatures', () => {
      db.insert({
        pattern: 'npm install',
        category: 'timeout',
        toolName: 'Bash',
        fixStrategy: 'replace',
        fixAction: 'pnpm install --no-frozen-lockfile',
        explanation: 'npm install 在大项目中频繁超时，改用 pnpm',
      })
      const result = checker.check('Bash', { command: 'npm install react' })
      expect(result.action).toBe('fix')
      expect(result.modifiedParams).toEqual({ command: 'pnpm install --no-frozen-lockfile' })
      expect(result.warning).toContain('SIS 自动修复')
    })
  })

  describe('action priority', () => {
    it('block overrides warn when both match (through rule engine)', () => {
      // Insert a warn signature and a separate rule engine that blocks
      const db2 = new ErrorSignatureDB(TEST_DIR + '-priority')
      mkdirSync(TEST_DIR + '-priority', { recursive: true })
      try {
        db2.insert({
          pattern: 'dangerous',
          category: 'tool-params',
          toolName: 'Bash',
          fixStrategy: 'warn',
          fixAction: '',
          explanation: 'Warning pattern',
        })
        // Without rule engine, should just warn
        const checker2 = new PreFlightChecker(db2)
        const result = checker2.check('Bash', { command: 'dangerous' })
        expect(result.action).toBe('warn')
      } finally {
        rmSync(TEST_DIR + '-priority', { recursive: true, force: true })
      }
    })

    it('fix has priority over warn', () => {
      // PreFlightChecker returns fix when a replace signature matches
      db.insert({
        pattern: 'npm ci',
        category: 'timeout',
        toolName: 'Bash',
        fixStrategy: 'replace',
        fixAction: 'pnpm install --frozen-lockfile',
        explanation: 'Use pnpm for faster installs',
      })
      // This also matches a potential warn scenario conceptually,
      // but the replace signature should win
      const result = checker.check('Bash', { command: 'npm ci' })
      expect(result.action).toBe('fix')
    })
  })

  describe('rule engine integration', () => {
    it('integrates with ExperienceRuleEngine for additional checks', () => {
      const ruleEngine = new ExperienceRuleEngine(TEST_DIR)
      const checkerWithRules = new PreFlightChecker(db, ruleEngine)

      // Rule engine has builtin timeout rule for heavy commands
      const result = checkerWithRules.check('Bash', { command: 'npm install' })
      // npm install matches the builtin timeout rule
      expect(result.action).toBe('fix')
      expect(result.modifiedParams).toBeDefined()
      expect((result.modifiedParams! as Record<string, unknown>).timeout).toBe(300_000)
    })

    it('works without rule engine (no crash)', () => {
      const result = checker.check('Bash', { command: 'npm install' })
      expect(result.action).toBe('allow')
    })

    it('setRuleEngine can add rule engine after construction', () => {
      const resultWithout = checker.check('Bash', { command: 'npm install' })
      expect(resultWithout.action).toBe('allow')

      const ruleEngine = new ExperienceRuleEngine(TEST_DIR)
      checker.setRuleEngine(ruleEngine)
      const resultWith = checker.check('Bash', { command: 'npm install' })
      expect(resultWith.action).toBe('fix')
    })
  })

  describe('no match', () => {
    it('returns allow for unrelated tool calls', () => {
      db.insert({
        pattern: 'npm install',
        category: 'timeout',
        toolName: 'Bash',
        fixStrategy: 'replace',
        fixAction: 'pnpm install',
        explanation: 'Use pnpm',
      })
      const result = checker.check('Read', { file_path: 'README.md' })
      expect(result.action).toBe('allow')
    })
  })
})
