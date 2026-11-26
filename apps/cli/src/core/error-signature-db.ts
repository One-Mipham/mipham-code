/**
 * SIS (Self-Immune System) Phase 0: Error Signature Database
 *
 * Persistent storage for known error patterns. Each signature captures:
 *   - What error occurred (pattern matching against command/error text)
 *   - How to fix it (strategy + action)
 *   - How reliable the fix is (success rate tracking)
 *
 * Storage: JSON file at ~/.mipham/sis/error-signatures.json
 * Pattern: follows EffectivenessTracker's file-based persistence model
 *
 * Integration:
 *   AutoMemoryEngine.feedCrsiPipeline() → ErrorSignatureDB.insert()
 *   PreFlightChecker.check() → ErrorSignatureDB.match()
 */

import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { atomicWriteFileSync } from '../shared/atomic-write'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { miphamHome } from './paths.ts'

// ── Types ──

export interface ErrorSignature {
  /** Unique identifier */
  id: string
  /** Substring or regex pattern to match against command/error text */
  pattern: string
  /** Failure category: timeout | tool-params | import | search | semantic */
  category: string
  /** Associated tool name (e.g. 'Bash', 'Write') */
  toolName: string
  /** How to fix: replace params, prepend to command, append, warn only, or block entirely */
  fixStrategy: 'replace' | 'prepend' | 'append' | 'warn' | 'block'
  /** The fix action (e.g. 'pnpm install' replaces 'npm install') */
  fixAction: string
  /** Human-readable explanation of the fix */
  explanation: string
  /** Number of times this error has been encountered */
  occurrences: number
  /** Number of times the fix was applied successfully */
  successCount: number
  /** Number of times the fix was applied and the call still failed */
  failureCount: number
  /** ISO timestamp of first encounter */
  firstSeen: string
  /** ISO timestamp of most recent encounter */
  lastSeen: string
  /** Fix success rate (0.0-1.0) */
  successRate: number
  /** Current status */
  status: 'active' | 'degraded' | 'retired'
}

export interface ErrorSignatureStats {
  total: number
  active: number
  degraded: number
  retired: number
  /**
   * Active signatures whose strategy applies a fix (`replace`/`prepend`/`append`).
   * `avgSuccessRate` is averaged over these only — `warn`/`block` have no fix to
   * succeed, and counting their 0es made every advisory look like a failed fix.
   */
  fixable: number
  avgSuccessRate: number
  totalInterceptions: number
}

// ── Constants ──

const DEFAULT_STORE_DIR = miphamHome('sis')
const STORE_FILE = 'error-signatures.json'
const MIN_SUCCESS_RATE = 0.5 // below this → degraded
const RETIREMENT_RATE = 0.2 // below this and > 90 days old → retired
/**
 * Attempts needed before an outcome can degrade a signature. One failed call is
 * noise, not a verdict — degrading on it would retire a fix the first time it
 * met a flaky command.
 */
const MIN_ATTEMPTS_FOR_DEGRADE = 3

/** Strategies that actually apply a fix. `warn`/`block` never do. */
export function isAutoFixable(sig: Pick<ErrorSignature, 'fixStrategy'>): boolean {
  return (
    sig.fixStrategy === 'replace' || sig.fixStrategy === 'prepend' || sig.fixStrategy === 'append'
  )
}

/** The fix-success rate, or `—` when the strategy does not apply a fix. */
export function formatFixRate(sig: ErrorSignature): string {
  return isAutoFixable(sig) ? `${Math.round(sig.successRate * 100)}%` : '—'
}
const RETENTION_DAYS = 90 // auto-clean retired signatures older than this

// ── Database ──

export class ErrorSignatureDB {
  private signatures: Map<string, ErrorSignature> = new Map()
  private storePath: string
  private dirty = false

  constructor(storeDir: string = DEFAULT_STORE_DIR) {
    this.storePath = join(storeDir, STORE_FILE)
    this.load()
  }

  // ── Persistence ──

  /** Load signatures from disk. Non-existent file = clean slate. */
  private load(): void {
    try {
      if (!existsSync(this.storePath)) return
      const raw = readFileSync(this.storePath, 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      // 形状门：`["x"]` 是合法 JSON、`for…of` 也照收 —— `sig.id` 是 `undefined`，
      // 于是库里躺着一个**没有 id 的成员**（后面 `get(id)` 永远找不到它，
      // 而 `getStats()` 的分母把它算进去）。形状不验 = 垃圾静默入库。
      if (!Array.isArray(parsed)) return
      for (const sig of parsed) {
        if (!sig || typeof sig !== 'object' || typeof sig.id !== 'string') continue
        // Stores written before 2026-11-26 have no `failureCount`; without this,
        // the first `failureCount + 1` is NaN and the rate silently becomes NaN.
        if (typeof sig.failureCount !== 'number') sig.failureCount = 0
        this.signatures.set(sig.id, sig)
      }
    } catch {
      // Corrupted or missing file — start fresh
    }
  }

  /** Persist signatures to disk. Debounced: only writes if dirty. */
  private save(): void {
    if (!this.dirty) return
    try {
      mkdirSync(join(this.storePath, '..'), { recursive: true })
      const arr = Array.from(this.signatures.values())
      atomicWriteFileSync(this.storePath, JSON.stringify(arr, null, 2), { mode: 0o644 })
      this.dirty = false
    } catch {
      // Best-effort persistence — never crash on write failure
    }
  }

  // ── CRUD ──

  /**
   * Insert a new error signature. If a signature with the same pattern +
   * toolName + category already exists, increment its occurrence count instead.
   */
  insert(
    sig: Omit<
      ErrorSignature,
      | 'id'
      | 'occurrences'
      | 'successCount'
      | 'failureCount'
      | 'successRate'
      | 'firstSeen'
      | 'lastSeen'
      | 'status'
    >,
  ): ErrorSignature {
    // Dedup: same pattern + toolName + category → update existing
    const existing = this.findByPattern(sig.pattern, sig.toolName, sig.category)
    if (existing) {
      existing.occurrences++
      existing.lastSeen = new Date().toISOString()
      existing.successRate =
        existing.occurrences > 0 ? existing.successCount / existing.occurrences : 1.0
      this.dirty = true
      this.save()
      return existing
    }

    const now = new Date().toISOString()
    const id = `sis-${randomUUID().slice(0, 8)}`
    const full: ErrorSignature = {
      ...sig,
      id,
      occurrences: 1,
      successCount: 0,
      failureCount: 0,
      successRate: 0,
      firstSeen: now,
      lastSeen: now,
      status: 'active',
    }

    this.signatures.set(id, full)
    this.dirty = true
    this.save()
    return full
  }

  /**
   * Match a tool call against known error signatures.
   * Returns the best-matching active signature, or null if no match.
   *
   * Matching strategy:
   *   1. Exact toolName match
   *   2. Pattern substring match in command/error text
   *   3. Category match as tiebreaker
   */
  match(toolName: string, params: Record<string, unknown>): ErrorSignature | null {
    const text = this.paramsToText(toolName, params)
    let best: ErrorSignature | null = null
    let bestScore = 0

    for (const sig of this.signatures.values()) {
      if (sig.status === 'retired') continue
      if (sig.toolName !== toolName) continue

      // Pattern must match — this is the primary filter
      if (!text.toLowerCase().includes(sig.pattern.toLowerCase())) continue

      // Score tiebreakers when multiple signatures match
      let score = 10 // base score for pattern match
      score += sig.successRate * 5
      score += Math.min(sig.occurrences / 10, 1) * 2
      if (sig.status === 'active') score += 1

      if (score > bestScore) {
        bestScore = score
        best = sig
      }
    }

    return best
  }

  /**
   * Record the result of applying a fix for a given signature.
   *
   * Only signatures whose strategy actually applies a fix are scored — `warn`
   * and `block` have no outcome, and counting one drove every advisory to 0%
   * (2026-11-26: 10 signatures, 202 occurrences, 0 successes, while this method
   * had no production caller). The denominator is **attempts**, not occurrences:
   * a signature seen ten times but tried once has a rate of one trial.
   */
  recordResult(id: string, success: boolean): void {
    const sig = this.signatures.get(id)
    if (!sig) return
    if (!isAutoFixable(sig)) return

    if (success) sig.successCount++
    else sig.failureCount++

    const attempts = sig.successCount + sig.failureCount
    sig.successRate = attempts > 0 ? sig.successCount / attempts : 0

    // Auto-degrade — only after a real attempt history; one failure is noise.
    if (
      attempts >= MIN_ATTEMPTS_FOR_DEGRADE &&
      sig.successRate < MIN_SUCCESS_RATE &&
      sig.status === 'active'
    ) {
      sig.status = 'degraded'
    }
    // Auto-retire
    const ageDays = (Date.now() - new Date(sig.firstSeen).getTime()) / (1000 * 60 * 60 * 24)
    if (
      attempts >= MIN_ATTEMPTS_FOR_DEGRADE &&
      sig.successRate < RETIREMENT_RATE &&
      ageDays > 90 &&
      sig.status === 'degraded'
    ) {
      sig.status = 'retired'
    }

    this.dirty = true
    this.save()
  }

  // ── Query ──

  /** Get all active and degraded signatures (excludes retired). */
  getActive(): ErrorSignature[] {
    return Array.from(this.signatures.values())
      .filter((s) => s.status !== 'retired')
      .sort((a, b) => b.occurrences - a.occurrences)
  }

  /** Get a specific signature by ID. */
  get(id: string): ErrorSignature | undefined {
    return this.signatures.get(id)
  }

  /** Manually retire a signature. */
  retire(id: string): boolean {
    const sig = this.signatures.get(id)
    if (!sig) return false
    sig.status = 'retired'
    this.dirty = true
    this.save()
    return true
  }

  /** Get aggregate statistics. */
  getStats(): ErrorSignatureStats {
    const all = Array.from(this.signatures.values())
    const active = all.filter((s) => s.status === 'active')
    const degraded = all.filter((s) => s.status === 'degraded')
    const retired = all.filter((s) => s.status === 'retired')

    const fixableActive = active.filter(isAutoFixable)
    const avgSuccessRate =
      fixableActive.length > 0
        ? fixableActive.reduce((sum, s) => sum + s.successRate, 0) / fixableActive.length
        : 0

    return {
      total: all.length,
      active: active.length,
      degraded: degraded.length,
      retired: retired.length,
      fixable: fixableActive.length,
      avgSuccessRate: Math.round(avgSuccessRate * 100) / 100,
      totalInterceptions: all.reduce((sum, s) => sum + s.occurrences, 0),
    }
  }

  /**
   * Clean up old retired signatures and low-performing degraded ones.
   * Called periodically (e.g. on daemon startup or via /sis cleanup).
   */
  cleanup(retentionDays: number = RETENTION_DAYS): number {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    let removed = 0

    for (const [id, sig] of this.signatures) {
      if (sig.status === 'retired' && new Date(sig.lastSeen).getTime() < cutoff) {
        this.signatures.delete(id)
        removed++
      }
    }

    if (removed > 0) {
      this.dirty = true
      this.save()
    }

    return removed
  }

  /** Clear all signatures. Used for testing and manual reset. */
  clear(): void {
    this.signatures.clear()
    this.dirty = true
    this.save()
  }

  // ── Private Helpers ──

  /** Find an existing signature by pattern + toolName + category. */
  private findByPattern(
    pattern: string,
    toolName: string,
    category: string,
  ): ErrorSignature | undefined {
    for (const sig of this.signatures.values()) {
      if (sig.pattern === pattern && sig.toolName === toolName && sig.category === category) {
        return sig
      }
    }
    return undefined
  }

  /** Convert tool params to a searchable text blob for pattern matching. */
  private paramsToText(toolName: string, params: Record<string, unknown>): string {
    const parts: string[] = [toolName]
    if (params.command && typeof params.command === 'string') {
      parts.push(params.command)
    }
    if (params.file_path && typeof params.file_path === 'string') {
      parts.push(params.file_path)
    }
    if (params.description && typeof params.description === 'string') {
      parts.push(params.description)
    }
    if (params.error && typeof params.error === 'string') {
      parts.push(params.error)
    }
    return parts.join(' ')
  }
}
