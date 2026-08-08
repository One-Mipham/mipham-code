import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

export interface RuleEffectiveness {
  ruleId: string
  appliedCount: number
  successAfterCount: number
  preRuleFailureRate: number
  postRuleFailureRate: number
  status: 'active' | 'degrading' | 'disabled'
  createdAt: string
  lastEvaluatedAt: string
  evaluationHistory: Array<{
    date: string
    appliedCount: number
    failureRate: number
  }>
}

const EVAL_THRESHOLD = 10 // evaluate after 10 applications
const STORE_FILE = 'effectiveness.json'

export class EffectivenessTracker {
  private data: Map<string, RuleEffectiveness>
  private storePath: string

  constructor(storeDir: string = join(process.env.HOME || '~', '.mipham', 'rule-engine')) {
    this.storePath = join(storeDir, STORE_FILE)
    this.data = new Map()
  }

  recordApplication(ruleId: string, success: boolean): void {
    let eff = this.data.get(ruleId)
    if (!eff) {
      eff = {
        ruleId,
        appliedCount: 0,
        successAfterCount: 0,
        preRuleFailureRate: 1.0,
        postRuleFailureRate: 0,
        status: 'active',
        createdAt: new Date().toISOString().slice(0, 10),
        lastEvaluatedAt: '',
        evaluationHistory: [],
      }
      this.data.set(ruleId, eff)
    }

    eff.appliedCount++
    if (success) eff.successAfterCount++

    // Calculate current failure rate
    if (eff.appliedCount >= EVAL_THRESHOLD) {
      eff.postRuleFailureRate = 1 - eff.successAfterCount / eff.appliedCount
    }
  }

  /**
   * Evaluate rule effectiveness and return auto-management actions.
   *
   * @param autoRuleManagement — when false, skip auto-degrade/disable/enable logic
   *   but still record evaluation history for manual review. Default true.
   */
  evaluate(autoRuleManagement = true): {
    upgrades: string[]
    degradations: string[]
    disables: string[]
  } {
    const result = {
      upgrades: [] as string[],
      degradations: [] as string[],
      disables: [] as string[],
    }
    const now = new Date().toISOString().slice(0, 10)

    for (const [ruleId, eff] of this.data) {
      if (eff.appliedCount < EVAL_THRESHOLD) continue

      eff.lastEvaluatedAt = now
      eff.evaluationHistory.push({
        date: now,
        appliedCount: eff.appliedCount,
        failureRate: eff.postRuleFailureRate,
      })

      // Keep max 10 history entries
      if (eff.evaluationHistory.length > 10) {
        eff.evaluationHistory = eff.evaluationHistory.slice(-10)
      }

      // Auto-management is gated by crsi.autoRuleManagement feature flag
      if (!autoRuleManagement) continue

      // Degrade: active rule with high failure rate
      if (eff.status === 'active' && eff.postRuleFailureRate > 0.6) {
        eff.status = 'degrading'
        result.degradations.push(ruleId)
      }

      // Disable: degrading rule with no improvement across evaluations
      if (eff.status === 'degrading' && eff.evaluationHistory.length >= 2) {
        const last = eff.evaluationHistory[eff.evaluationHistory.length - 1]
        const prev = eff.evaluationHistory[eff.evaluationHistory.length - 2]
        if (last!.failureRate >= prev!.failureRate) {
          eff.status = 'disabled'
          result.disables.push(ruleId)
        }
      }

      // Upgrade: degrading rule that has improved significantly
      if (eff.status === 'degrading' && eff.postRuleFailureRate < 0.4) {
        eff.status = 'active'
        result.upgrades.push(ruleId)
      }
    }

    return result
  }

  getEffectiveness(ruleId: string): RuleEffectiveness | null {
    return this.data.get(ruleId) || null
  }

  persist(): void {
    const dir = dirname(this.storePath)
    mkdirSync(dir, { recursive: true })

    const obj: Record<string, RuleEffectiveness> = {}
    for (const [k, v] of this.data) {
      obj[k] = v
    }
    writeFileSync(this.storePath, JSON.stringify(obj, null, 2), 'utf-8')
  }

  load(): void {
    if (!existsSync(this.storePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.storePath, 'utf-8'))
      this.data = new Map(Object.entries(raw))
    } catch {
      // Corrupt file — start fresh
      this.data = new Map()
    }
  }

  get allRules(): RuleEffectiveness[] {
    return Array.from(this.data.values())
  }
}
