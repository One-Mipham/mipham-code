import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ErrorSignatureDB, type ErrorSignature } from '../../src/core/error-signature-db'
import { EffectivenessTracker } from '../../src/agent/effectiveness-tracker'
import { MetaRuleEngine } from '../../src/core/meta-rule-engine'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TEST_DIR = join('/tmp', `sis-meta-test-${randomUUID()}`)
const TRACKER_DIR = join('/tmp', `sis-meta-tracker-${randomUUID()}`)

/** Create a signature with specified occurrences and success count for testing */
function createSig(
  db: ErrorSignatureDB,
  opts: {
    pattern: string
    category: string
    toolName: string
    fixStrategy: ErrorSignature['fixStrategy']
    fixAction: string
    explanation: string
    occurrences: number
    successCount: number
  },
): ErrorSignature {
  const sig = db.insert({
    pattern: opts.pattern,
    category: opts.category,
    toolName: opts.toolName,
    fixStrategy: opts.fixStrategy,
    fixAction: opts.fixAction,
    explanation: opts.explanation,
  })
  // Override occurrences/successCount directly (insert starts at 1/0)
  sig.occurrences = opts.occurrences
  sig.successCount = opts.successCount
  sig.successRate = opts.occurrences > 0 ? opts.successCount / opts.occurrences : 0
  return sig
}

describe('MetaRuleEngine', () => {
  let db: ErrorSignatureDB
  let tracker: EffectivenessTracker
  let engine: MetaRuleEngine

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    mkdirSync(TRACKER_DIR, { recursive: true })
    db = new ErrorSignatureDB(TEST_DIR)
    tracker = new EffectivenessTracker(TRACKER_DIR)
    engine = new MetaRuleEngine(db, tracker)
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
    if (existsSync(TRACKER_DIR)) rmSync(TRACKER_DIR, { recursive: true, force: true })
  })

  describe('empty state', () => {
    it('returns empty metaRules when no signatures exist', () => {
      const result = engine.analyze()
      expect(result.metaRules).toEqual([])
      expect(result.systemHealth).toBeDefined()
    })

    it('returns baseline system health (score 40-60) with no data', () => {
      const result = engine.analyze()
      expect(result.systemHealth.score).toBeGreaterThanOrEqual(40)
      expect(result.systemHealth.score).toBeLessThanOrEqual(60)
    })

    it('includes default recommendation when no data', () => {
      const result = engine.analyze()
      expect(result.systemHealth.recommendations.length).toBeGreaterThan(0)
    })
  })

  describe('threshold tuning', () => {
    it('suggests lowering retry threshold when many signatures are near threshold', () => {
      // Need >= MIN_SAMPLE_SIZE (5) total, >= 3 near threshold for rule generation
      // Baseline sigs (not near threshold, to meet MIN_SAMPLE_SIZE)
      createSig(db, {
        pattern: 'high-success-sig',
        category: 'timeout',
        toolName: 'Bash',
        fixStrategy: 'replace',
        fixAction: 'good fix',
        explanation: 'High success',
        occurrences: 10,
        successCount: 10, // 100% — not near threshold
      })

      // Create 4 signatures with success rate between 0.5-0.69, occurrences >= 5
      for (let i = 0; i < 4; i++) {
        createSig(db, {
          pattern: `near-threshold-pattern-${i}`,
          category: 'timeout',
          toolName: 'Bash',
          fixStrategy: 'prepend',
          fixAction: 'timeout=300000',
          explanation: 'Near threshold timeout',
          occurrences: 10,
          successCount: 6, // 6/10 = 0.6
        })
      }

      const result = engine.analyze()
      const thresholdRules = result.metaRules.filter((r) => r.category === 'threshold-tuning')
      const retryRule = thresholdRules.find((r) => r.title.includes('降低自动重试阈值'))
      expect(retryRule).toBeDefined()
      expect(retryRule!.confidence).toBe('medium') // 4 sigs, needs 5 for high
    })

    it('suggests accelerating zero-success retirement', () => {
      // Need >= 5 total sigs and >= 5 zero-success for rule
      for (let i = 0; i < 7; i++) {
        createSig(db, {
          pattern: `zero-success-${i}`,
          category: 'semantic',
          toolName: 'Bash',
          fixStrategy: 'warn',
          fixAction: '',
          explanation: 'Always fails',
          occurrences: 5,
          successCount: 0,
        })
      }

      const result = engine.analyze()
      const zeroRules = result.metaRules.filter(
        (r) => r.category === 'threshold-tuning' && r.title.includes('零成功率'),
      )
      expect(zeroRules.length).toBe(1)
    })
  })

  describe('strategy optimization', () => {
    it('compares fixStrategy effectiveness per category', () => {
      // Need >= MIN_SAMPLE_SIZE (5) total sigs
      // 3 replace (high success) + 3 warn (low success) = 6 total
      for (let i = 0; i < 3; i++) {
        createSig(db, {
          pattern: `timeout-replace-${i}`,
          category: 'timeout',
          toolName: 'Bash',
          fixStrategy: 'replace',
          fixAction: 'pnpm install',
          explanation: 'Replace npm with pnpm',
          occurrences: 10,
          successCount: 10,
        })
      }

      for (let i = 0; i < 3; i++) {
        createSig(db, {
          pattern: `timeout-warn-${i}`,
          category: 'timeout',
          toolName: 'Bash',
          fixStrategy: 'warn',
          fixAction: '',
          explanation: 'Just warn about timeout',
          occurrences: 10,
          successCount: 2,
        })
      }

      const result = engine.analyze()
      const strategyRules = result.metaRules.filter((r) => r.category === 'strategy-optimization')
      expect(strategyRules.length).toBeGreaterThanOrEqual(1)
      const timeoutRule = strategyRules.find((r) => r.title.includes('timeout'))
      expect(timeoutRule).toBeDefined()
      expect(timeoutRule!.evidence.metrics.bestStrategyAvg).toBeGreaterThan(0.8)
      expect(timeoutRule!.evidence.metrics.worstStrategyAvg).toBeLessThan(0.3)
    })

    it('does not generate strategy rules with insufficient data', () => {
      // Only 1 signature per strategy, occurrences < 3 — filtered out
      createSig(db, {
        pattern: 'single-timeout',
        category: 'timeout',
        toolName: 'Bash',
        fixStrategy: 'replace',
        fixAction: 'fix',
        explanation: 'Single',
        occurrences: 1,
        successCount: 0,
      })
      createSig(db, {
        pattern: 'single-warn',
        category: 'timeout',
        toolName: 'Bash',
        fixStrategy: 'warn',
        fixAction: '',
        explanation: 'Single warn',
        occurrences: 1,
        successCount: 0,
      })

      const result = engine.analyze()
      const strategyRules = result.metaRules.filter((r) => r.category === 'strategy-optimization')
      expect(strategyRules.length).toBe(0)
    })
  })

  describe('cross-rule patterns', () => {
    it('detects dominant tool in high-success signatures', () => {
      // Need >= 8 total sigs for cross-rule analysis
      // 12 high-success Bash + 2 high-success Write = 14 total
      for (let i = 0; i < 12; i++) {
        createSig(db, {
          pattern: `bash-success-${i}`,
          category: i % 2 === 0 ? 'timeout' : 'tool-params',
          toolName: 'Bash',
          fixStrategy: 'prepend',
          fixAction: 'timeout=300000',
          explanation: 'Bash fix',
          occurrences: 10,
          successCount: 10,
        })
      }

      for (let i = 0; i < 2; i++) {
        createSig(db, {
          pattern: `write-success-${i}`,
          category: 'import',
          toolName: 'Write',
          fixStrategy: 'replace',
          fixAction: 'add .js extension',
          explanation: 'Write fix',
          occurrences: 10,
          successCount: 10,
        })
      }

      const result = engine.analyze()
      const toolRules = result.metaRules.filter(
        (r) => r.category === 'cross-rule-pattern' && r.title.includes('Bash'),
      )
      expect(toolRules.length).toBeGreaterThanOrEqual(1)
    })

    it('detects common fix action patterns', () => {
      // Need >= 8 total; 4 with matching fixAction bigram is enough
      for (let i = 0; i < 6; i++) {
        createSig(db, {
          pattern: `retry-pattern-${i}`,
          category: 'timeout',
          toolName: 'Bash',
          fixStrategy: 'prepend',
          fixAction: 'timeout=300000 retry-command',
          explanation: `Timeout fix ${i}`,
          occurrences: 5,
          successCount: 4,
        })
      }
      // Add some other sigs to meet 8 total
      for (let i = 0; i < 3; i++) {
        createSig(db, {
          pattern: `other-pattern-${i}`,
          category: 'import',
          toolName: 'Write',
          fixStrategy: 'replace',
          fixAction: 'add .js extension',
          explanation: `Import fix ${i}`,
          occurrences: 5,
          successCount: 5,
        })
      }

      const result = engine.analyze()
      const bigramRules = result.metaRules.filter(
        (r) => r.category === 'cross-rule-pattern' && r.title.includes('timeout=300000'),
      )
      expect(bigramRules.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('emergent category detection', () => {
    it('detects rate-limit as emergent category', () => {
      // Need >= 10 total sigs for emergent category detection
      for (let i = 0; i < 5; i++) {
        createSig(db, {
          pattern: `rate limit exceeded for api key ${i}`,
          category: 'semantic',
          toolName: 'Bash',
          fixStrategy: 'warn',
          fixAction: '',
          explanation: 'Rate limit error',
          occurrences: 3,
          successCount: 0,
        })
      }
      // Add filler to reach 10 total
      for (let i = 0; i < 5; i++) {
        createSig(db, {
          pattern: `filler-pattern-${i}`,
          category: 'timeout',
          toolName: 'Bash',
          fixStrategy: 'replace',
          fixAction: 'fix',
          explanation: `Filler ${i}`,
          occurrences: 5,
          successCount: 5,
        })
      }

      const result = engine.analyze()
      const emergentRules = result.metaRules.filter((r) => r.category === 'category-emergence')
      const rateLimitRule = emergentRules.find((r) => r.title.includes('rate limit'))
      expect(rateLimitRule).toBeDefined()
      expect(rateLimitRule!.confidence).toBe('high') // 5 occurrences → high
    })

    it('detects auth-related patterns', () => {
      // Need >= 10 total sigs
      for (let i = 0; i < 3; i++) {
        createSig(db, {
          pattern: `auth token expired ${i}`,
          category: 'semantic',
          toolName: 'Bash',
          fixStrategy: 'warn',
          fixAction: '',
          explanation: 'Auth error',
          occurrences: 3,
          successCount: 0,
        })
      }
      // Filler to reach 10
      for (let i = 0; i < 7; i++) {
        createSig(db, {
          pattern: `filler-auth-${i}`,
          category: 'timeout',
          toolName: 'Bash',
          fixStrategy: 'replace',
          fixAction: 'fix',
          explanation: `Filler ${i}`,
          occurrences: 5,
          successCount: 5,
        })
      }

      const result = engine.analyze()
      const authRules = result.metaRules.filter(
        (r) => r.category === 'category-emergence' && r.title.includes('token'),
      )
      expect(authRules.length).toBe(1)
    })
  })

  describe('system health', () => {
    it('computes high health score with many high-success signatures', () => {
      for (let i = 0; i < 20; i++) {
        const sig = createSig(db, {
          pattern: `healthy-${i}`,
          category: 'timeout',
          toolName: 'Bash',
          fixStrategy: 'replace',
          fixAction: 'good fix',
          explanation: 'Healthy signature',
          occurrences: 10,
          successCount: 10,
        })
        tracker.recordApplication(sig.id, true)
      }

      const result = engine.analyze()
      expect(result.systemHealth.score).toBeGreaterThanOrEqual(80)
      expect(result.systemHealth.assessment).toContain('🟢')
    })

    it('computes low health score with few low-success signatures', () => {
      for (let i = 0; i < 2; i++) {
        createSig(db, {
          pattern: `weak-${i}`,
          category: 'semantic',
          toolName: 'Bash',
          fixStrategy: 'warn',
          fixAction: '',
          explanation: 'Weak signature',
          occurrences: 3,
          successCount: 0,
        })
      }

      const result = engine.analyze()
      expect(result.systemHealth.score).toBeLessThan(60)
    })
  })

  describe('getAutoApplicable', () => {
    it('returns only high-confidence auto-applicable meta-rules', () => {
      const metaRules = [
        {
          id: 'auto-1',
          category: 'strategy-optimization' as const,
          title: 'Auto rule',
          description: 'Desc',
          recommendation: 'Rec',
          autoApplicable: true,
          evidence: {
            sampleSize: 10,
            metrics: {},
            relatedIds: [],
            summary: 'Test',
          },
          confidence: 'high' as const,
          generatedAt: new Date().toISOString(),
        },
        {
          id: 'no-auto-1',
          category: 'threshold-tuning' as const,
          title: 'Manual rule',
          description: 'Desc',
          recommendation: 'Rec',
          autoApplicable: false,
          evidence: {
            sampleSize: 5,
            metrics: {},
            relatedIds: [],
            summary: 'Test',
          },
          confidence: 'high' as const,
          generatedAt: new Date().toISOString(),
        },
        {
          id: 'no-auto-2',
          category: 'strategy-optimization' as const,
          title: 'Low confidence',
          description: 'Desc',
          recommendation: 'Rec',
          autoApplicable: true,
          evidence: {
            sampleSize: 3,
            metrics: {},
            relatedIds: [],
            summary: 'Test',
          },
          confidence: 'low' as const,
          generatedAt: new Date().toISOString(),
        },
      ]

      const applicable = engine.getAutoApplicable(metaRules)
      expect(applicable.length).toBe(1)
      expect(applicable[0]!.id).toBe('auto-1')
    })
  })
})
