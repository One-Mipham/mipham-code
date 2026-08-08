import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EffectivenessTracker } from '../../src/agent/effectiveness-tracker.js'

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
})
