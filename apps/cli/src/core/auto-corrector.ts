/**
 * SIS Phase 2: Auto-Corrector — Post-Error Self-Healing
 *
 * Second defense line of the self-immune system. When a tool call fails:
 *   1. Analyzes the error against ErrorSignatureDB for known patterns
 *   2. If a high-confidence fix exists → returns corrected params for re-execution
 *   3. If a low-confidence match → returns suggestion without auto-applying
 *   4. Feeds new error patterns back to ErrorSignatureDB for future immunity
 *
 * Distinct from PreFlightChecker (pre-execution prevention) — AutoCorrector
 * handles errors AFTER they occur, enabling real-time self-healing.
 *
 * Flow:
 *   Tool executes → fails → AutoCorrector.analyze() → match & fix
 *     → if fix available: re-execute with corrected params
 *     → if no fix: record error signature, let user handle
 */

import type { ErrorSignatureDB, ErrorSignature } from './error-signature-db.js'

// ── Types ──

export interface CorrectionResult {
  /** Whether a correction was found */
  corrected: boolean
  /** The action taken */
  action: 'retry' | 'suggest' | 'record-only'
  /** Corrected parameters (for 'retry' action) */
  correctedParams?: Record<string, unknown>
  /** Human-readable suggestion (for 'suggest' action) */
  suggestion?: string
  /** Matched error signature (for tracking) */
  matchedSignature?: string
  /** New signature created (for tracking) */
  newSignatureId?: string
}

// ── Constants ──

/** Minimum success rate to auto-retry with corrected params */
const AUTO_RETRY_THRESHOLD = 0.7

/** Maximum retry attempts per tool call to prevent infinite loops */
const MAX_RETRIES = 1

// ── Corrector ──

export class AutoCorrector {
  private errorDB: ErrorSignatureDB

  constructor(errorDB: ErrorSignatureDB) {
    this.errorDB = errorDB
  }

  /**
   * Analyze a failed tool call and attempt correction.
   *
   * @param toolName  — e.g. 'Bash', 'Write'
   * @param params    — original tool parameters
   * @param error     — error message from the failed execution
   * @param retryCount — current retry count (0-indexed)
   * @returns CorrectionResult with action and corrected params if applicable
   */
  analyze(
    toolName: string,
    params: Record<string, unknown>,
    error: string,
    retryCount: number = 0,
  ): CorrectionResult {
    // Guard against infinite retry loops
    if (retryCount >= MAX_RETRIES) {
      return { corrected: false, action: 'record-only' }
    }

    // ── Step 1: Try to match against known error signatures ──
    const sig = this.errorDB.match(toolName, {
      ...params,
      error,
    })

    if (sig) {
      return this.handleKnownError(sig, params, error)
    }

    // ── Step 2: No match — record as new signature for future immunity ──
    return this.handleUnknownError(toolName, params, error)
  }

  /**
   * Record a manual correction (user fixed it themselves).
   * Updates the signature's success rate.
   */
  recordManualFix(signatureId: string, success: boolean): void {
    this.errorDB.recordResult(signatureId, success)
  }

  // ── Private ──

  /** Handle a known error pattern with an existing signature. */
  private handleKnownError(
    sig: ErrorSignature,
    params: Record<string, unknown>,
    _error: string,
  ): CorrectionResult {
    const confidence = sig.successRate

    // High confidence → auto-retry with corrected params
    if (
      confidence >= AUTO_RETRY_THRESHOLD &&
      sig.fixStrategy !== 'warn' &&
      sig.fixStrategy !== 'block'
    ) {
      const correctedParams = this.applyFix(sig, params)
      return {
        corrected: true,
        action: 'retry',
        correctedParams,
        matchedSignature: sig.id,
      }
    }

    // Low/medium confidence → suggest but don't auto-apply
    return {
      corrected: false,
      action: 'suggest',
      suggestion: `🔧 SIS 建议: ${sig.explanation}\n   修复方案: ${sig.fixStrategy} → ${sig.fixAction}\n   历史成功率: ${Math.round(confidence * 100)}% (${sig.occurrences} 次)\n   使用 \`/sis errors\` 查看详情`,
      matchedSignature: sig.id,
    }
  }

  /** Handle an unknown error — record it for future immunity. */
  private handleUnknownError(
    toolName: string,
    params: Record<string, unknown>,
    error: string,
  ): CorrectionResult {
    // Extract a searchable pattern from the error
    const pattern = this.extractPattern(error)
    const category = this.categorizeError(error, toolName, params)

    const sig = this.errorDB.insert({
      pattern,
      category,
      toolName,
      fixStrategy: 'warn', // default: warn until we learn a fix
      fixAction: '',
      explanation: `未知错误模式: ${error.slice(0, 100)}`,
    })

    return {
      corrected: false,
      action: 'record-only',
      newSignatureId: sig.id,
      suggestion:
        `🆕 SIS 已记录新错误签名 \`${sig.id}\` (${category})。` + `此错误再次发生时将被自动识别。`,
    }
  }

  /** Apply a signature's fix to the original params. */
  private applyFix(sig: ErrorSignature, params: Record<string, unknown>): Record<string, unknown> {
    switch (sig.fixStrategy) {
      case 'replace':
        return { ...params, command: sig.fixAction }

      case 'prepend': {
        const cmd = String(params.command ?? '')
        return { ...params, command: `${sig.fixAction} ${cmd}` }
      }

      case 'append': {
        const cmd = String(params.command ?? '')
        return { ...params, command: `${cmd} ${sig.fixAction}` }
      }

      default:
        return params
    }
  }

  /**
   * Extract a stable, searchable pattern from an error message.
   * Strips dynamic content (paths, timestamps, UUIDs) to create a reusable signature.
   */
  private extractPattern(error: string): string {
    // Remove dynamic content
    const cleaned = error
      .replace(/\/[^\s]+\/[^\s]*/g, '/<path>') // paths
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, '<timestamp>') // timestamps
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>') // UUIDs
      .replace(/\d+/g, '<n>') // numbers
      .replace(/\s+/g, ' ') // normalize whitespace
      .trim()

    // Take first 200 chars as the pattern
    return cleaned.slice(0, 200)
  }

  /**
   * Categorize an error into one of the known CRSI categories.
   * Mirrors AutoMemoryEngine.categorizeFailure() logic for consistency.
   */
  private categorizeError(
    error: string,
    toolName: string,
    params: Record<string, unknown>,
  ): string {
    const err = error.toLowerCase()
    const cmd = String(params.command || params.description || '').toLowerCase()

    if (err.includes('timeout') || err.includes('timed out')) return 'timeout'
    if (cmd.includes('--force') || cmd.includes('rm -rf')) return 'tool-params'
    if (err.includes('import') || err.includes('module') || err.includes('.js')) return 'import'
    if (toolName === 'Grep' && err.includes('no matches')) return 'search'
    if (err.includes('permission') || err.includes('denied') || err.includes('eacces'))
      return 'tool-params'
    if (err.includes('not found') || err.includes('enoent')) return 'semantic'

    return 'semantic'
  }
}
