/**
 * SIS (Self-Immune System) Phase 0: Pre-Flight Checker
 *
 * Pre-execution interception layer that checks tool calls against:
 *   1. ErrorSignatureDB — known error patterns with proven fixes
 *   2. ExperienceRuleEngine — CRSI Phase 1 dynamic rules
 *
 * Returns one of four actions:
 *   - 'allow'  → no issue, proceed normally
 *   - 'warn'   → known risky pattern, show warning but allow
 *   - 'fix'    → known error with proven fix, auto-correct params
 *   - 'block'  → known dangerous pattern, refuse execution
 *
 * Priority: block > fix > warn > allow
 *   (most restrictive action wins when multiple sources match)
 */

import type { ErrorSignatureDB, ErrorSignature } from './error-signature-db.js'
import type { ExperienceRuleEngine } from './rule-engine.js'

// ── Types ──

export interface PreFlightResult {
  /** The action to take */
  action: 'allow' | 'warn' | 'fix' | 'block'
  /** Warning message (for 'warn' and 'block' actions) */
  warning?: string
  /** Modified parameters (for 'fix' action) */
  modifiedParams?: Record<string, unknown>
  /** Matched error signature ID (for tracking) */
  matchedSignature?: string
  /** Human-readable explanation of the fix */
  explanation?: string
}

// ── Action Priority ──

const ACTION_PRIORITY: Record<PreFlightResult['action'], number> = {
  allow: 0,
  warn: 1,
  fix: 2,
  block: 3,
}

// ── Checker ──

export class PreFlightChecker {
  private errorDB: ErrorSignatureDB
  private ruleEngine?: ExperienceRuleEngine

  constructor(errorDB: ErrorSignatureDB, ruleEngine?: ExperienceRuleEngine) {
    this.errorDB = errorDB
    this.ruleEngine = ruleEngine
  }

  /**
   * Check a tool call before execution.
   *
   * @param toolName — e.g. 'Bash', 'Write', 'Grep'
   * @param params  — tool input parameters
   * @returns PreFlightResult with the strictest applicable action
   */
  check(toolName: string, params: Record<string, unknown>): PreFlightResult {
    const results: PreFlightResult[] = []

    // ── Layer 1: ErrorSignatureDB ──
    const sig = this.errorDB.match(toolName, params)
    if (sig) {
      results.push(this.signatureToResult(sig, params))
    }

    // ── Layer 2: ExperienceRuleEngine ──
    if (this.ruleEngine) {
      const ruleResult = this.checkRuleEngine(toolName, params)
      if (ruleResult) {
        results.push(ruleResult)
      }
    }

    // ── Merge: pick the most restrictive result ──
    if (results.length === 0) {
      return { action: 'allow' }
    }

    return results.reduce((best, curr) =>
      ACTION_PRIORITY[curr.action] > ACTION_PRIORITY[best.action] ? curr : best,
    )
  }

  /**
   * Set/update the rule engine reference.
   * Useful when the rule engine is wired after construction.
   */
  setRuleEngine(ruleEngine: ExperienceRuleEngine): void {
    this.ruleEngine = ruleEngine
  }

  // ── Private: Signature Conversion ──

  /**
   * Convert an ErrorSignature to a PreFlightResult based on its fixStrategy.
   */
  private signatureToResult(sig: ErrorSignature, params: Record<string, unknown>): PreFlightResult {
    const base = {
      matchedSignature: sig.id,
      explanation: sig.explanation,
    }

    switch (sig.fixStrategy) {
      case 'block':
        return {
          ...base,
          action: 'block',
          warning: `⛔ SIS 免疫拦截: ${sig.explanation} (${sig.occurrences} 次历史发生，成功率 ${Math.round(sig.successRate * 100)}%)`,
        }

      case 'warn':
        return {
          ...base,
          action: 'warn',
          warning: `⚠️ SIS 预警: ${sig.explanation} (${sig.occurrences} 次历史发生)`,
        }

      case 'replace':
        return {
          ...base,
          action: 'fix',
          warning: `🔧 SIS 自动修复: ${sig.explanation}`,
          modifiedParams: this.applyReplace(sig),
        }

      case 'prepend':
        return {
          ...base,
          action: 'fix',
          warning: `🔧 SIS 自动修复: ${sig.explanation}`,
          modifiedParams: this.applyPrepend(params, sig),
        }

      case 'append':
        return {
          ...base,
          action: 'fix',
          warning: `🔧 SIS 自动修复: ${sig.explanation}`,
          modifiedParams: this.applyAppend(params, sig),
        }

      default:
        return { ...base, action: 'warn', warning: sig.explanation }
    }
  }

  // ── Private: Rule Engine Check ──

  /**
   * Check against the ExperienceRuleEngine.
   * Converts the rule engine's {modified, warnings} output to a PreFlightResult.
   */
  private checkRuleEngine(
    toolName: string,
    params: Record<string, unknown>,
  ): PreFlightResult | null {
    if (!this.ruleEngine) return null

    try {
      const { modified, warnings } = this.ruleEngine.intercept(toolName, params)
      const hasWarnings = warnings.length > 0
      const hasModifications = JSON.stringify(modified) !== JSON.stringify(params)

      if (!hasWarnings && !hasModifications) return null

      if (hasModifications) {
        return {
          action: 'fix',
          warning: warnings.join('; '),
          modifiedParams: modified,
          explanation: 'CRSI 规则引擎自动修正',
        }
      }

      if (hasWarnings) {
        return {
          action: 'warn',
          warning: warnings.join('; '),
        }
      }
    } catch {
      // Rule engine errors are non-fatal
    }

    return null
  }

  // ── Private: Fix Application Helpers ──

  /** 'replace' strategy: replace the entire command string. */
  private applyReplace(sig: ErrorSignature): Record<string, unknown> {
    return { command: sig.fixAction }
  }

  /** 'prepend' strategy: prepend text to the command. */
  private applyPrepend(
    params: Record<string, unknown>,
    sig: ErrorSignature,
  ): Record<string, unknown> {
    const cmd = String(params.command ?? '')
    return { ...params, command: `${sig.fixAction} ${cmd}` }
  }

  /** 'append' strategy: append text to the command. */
  private applyAppend(
    params: Record<string, unknown>,
    sig: ErrorSignature,
  ): Record<string, unknown> {
    const cmd = String(params.command ?? '')
    return { ...params, command: `${cmd} ${sig.fixAction}` }
  }
}
