import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EffectivenessTracker } from '../../src/agent/effectiveness-tracker.js'
import type { CrsiProvenanceBridge } from '../../src/agent/crsi-provenance-bridge.js'

describe('EffectivenessTracker', () => {
  let tracker: EffectivenessTracker
  let storePath: string

  beforeEach(() => {
    storePath = join(tmpdir(), `crsi-eff-${Date.now()}`)
    tracker = new EffectivenessTracker(storePath)
  })

  afterEach(() => {
    if (existsSync(storePath)) {
      rmSync(storePath, { recursive: true, force: true })
    }
  })

  it('starts with no effectiveness data', () => {
    expect(tracker.getEffectiveness('nonexistent')).toBeNull()
  })

  it('recordApplication tracks success/failure', () => {
    tracker.recordApplication('rule-test', true)
    tracker.recordApplication('rule-test', true)
    tracker.recordApplication('rule-test', false)

    const eff = tracker.getEffectiveness('rule-test')
    expect(eff).toBeDefined()
    expect(eff!.appliedCount).toBe(3)
    expect(eff!.successAfterCount).toBe(2)
  })

  it('evaluate returns empty when no rules have enough data', () => {
    tracker.recordApplication('rule-test', true)
    const result = tracker.evaluate()
    expect(result.upgrades).toEqual([])
    expect(result.degradations).toEqual([])
    expect(result.disables).toEqual([])
  })

  it('evaluate does not degrade rules that are working', () => {
    // 10 successes in a row
    for (let i = 0; i < 10; i++) {
      tracker.recordApplication('rule-good', true)
    }
    const result = tracker.evaluate()
    expect(result.degradations).toEqual([])
    expect(result.disables).toEqual([])
  })

  it('degrades rule with >60% failure rate', () => {
    // 10 applications: 8 failures, 2 successes → failure rate = 0.8 > 0.6
    for (let i = 0; i < 10; i++) {
      tracker.recordApplication('rule-bad', i >= 8)
    }
    const result = tracker.evaluate()
    expect(result.degradations).toEqual(['rule-bad'])

    const eff = tracker.getEffectiveness('rule-bad')
    expect(eff).toBeDefined()
    expect(eff!.status).toBe('degrading')
    expect(eff!.postRuleFailureRate).toBe(0.8)
  })

  it('disables rule that shows no improvement after degrading', () => {
    // First: 10 applications with 8 failures → degrade
    for (let i = 0; i < 10; i++) {
      tracker.recordApplication('rule-worsening', i >= 8)
    }
    tracker.evaluate()
    let eff = tracker.getEffectiveness('rule-worsening')
    expect(eff!.status).toBe('degrading')

    // Add more failures, keeping failure rate high → second evaluate should disable
    for (let i = 0; i < 10; i++) {
      tracker.recordApplication('rule-worsening', i >= 8)
    }
    const result = tracker.evaluate()
    expect(result.disables).toContain('rule-worsening')

    eff = tracker.getEffectiveness('rule-worsening')
    expect(eff!.status).toBe('disabled')
  })

  it('upgrades degraded rule back to active when failure rate drops', () => {
    // First: 10 applications with 8 failures → degrade
    for (let i = 0; i < 10; i++) {
      tracker.recordApplication('rule-recovering', i >= 8)
    }
    tracker.evaluate()
    let eff = tracker.getEffectiveness('rule-recovering')
    expect(eff!.status).toBe('degrading')

    // Add 10 successes → failure rate drops to ~0.4 (8 failures / 20 total)
    for (let i = 0; i < 10; i++) {
      tracker.recordApplication('rule-recovering', true)
    }
    // Failure rate = 8/20 = 0.4. That's not < 0.4, so add 1 more success
    tracker.recordApplication('rule-recovering', true)
    // Now: 8 failures / 21 = ~0.381 < 0.4
    const result = tracker.evaluate()
    expect(result.upgrades).toContain('rule-recovering')

    eff = tracker.getEffectiveness('rule-recovering')
    expect(eff!.status).toBe('active')
  })

  it('persist and load roundtrip', () => {
    tracker.recordApplication('rule-test', true)
    tracker.recordApplication('rule-test', false)
    tracker.persist()

    const tracker2 = new EffectivenessTracker(storePath)
    tracker2.load()
    const eff = tracker2.getEffectiveness('rule-test')
    expect(eff).toBeDefined()
    expect(eff!.appliedCount).toBe(2)
    expect(eff!.successAfterCount).toBe(1)
  })

  it('records evaluation history', () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordApplication('rule-test', i < 5) // 5 success, 5 failure
    }
    // Force evaluation by checking
    tracker.evaluate()
    const eff = tracker.getEffectiveness('rule-test')
    expect(eff).toBeDefined()
    expect(eff!.evaluationHistory.length).toBeGreaterThan(0)
  })

  it('reports effective verdict to megasystem when a decision id is set', () => {
    const evaluateDecision = vi.fn(() => Promise.resolve(true))
    const bridge = { evaluateDecision } as unknown as CrsiProvenanceBridge
    tracker.setProvenanceBridge(bridge)
    tracker.recordApplication('rule-good', true)
    tracker.setDecisionId('rule-good', 'd1')
    for (let i = 0; i < 9; i++) tracker.recordApplication('rule-good', true)

    tracker.evaluate()

    expect(evaluateDecision).toHaveBeenCalledWith(
      'd1',
      'effective',
      expect.objectContaining({ score: 0 }),
    )
  })

  it('reports ineffective verdict when failure rate is high', () => {
    const evaluateDecision = vi.fn(() => Promise.resolve(true))
    const bridge = { evaluateDecision } as unknown as CrsiProvenanceBridge
    tracker.setProvenanceBridge(bridge)
    tracker.recordApplication('rule-bad', false)
    tracker.setDecisionId('rule-bad', 'd2')
    for (let i = 0; i < 9; i++) tracker.recordApplication('rule-bad', false)

    tracker.evaluate()

    expect(evaluateDecision).toHaveBeenCalledWith(
      'd2',
      'ineffective',
      expect.objectContaining({ score: 1 }),
    )
  })

  it('does not report when no decision id is set', () => {
    const evaluateDecision = vi.fn(() => Promise.resolve(true))
    const bridge = { evaluateDecision } as unknown as CrsiProvenanceBridge
    tracker.setProvenanceBridge(bridge)
    for (let i = 0; i < 10; i++) tracker.recordApplication('rule-noid', true)

    tracker.evaluate()

    expect(evaluateDecision).not.toHaveBeenCalled()
  })

  it('does not crash without a bridge', () => {
    tracker.recordApplication('rule-nobridge', true)
    tracker.setDecisionId('rule-nobridge', 'd3')
    for (let i = 0; i < 9; i++) tracker.recordApplication('rule-nobridge', true)

    expect(() => tracker.evaluate()).not.toThrow()
  })
})
