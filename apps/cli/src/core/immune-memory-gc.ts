/**
 * SIS Phase 2: Immune Memory Garbage Collection
 *
 * Periodic cleanup of the error signature database:
 *   - Removes retired signatures older than retention period
 *   - Merges near-duplicate signatures (same tool + category, similar pattern)
 *   - Auto-retires signatures with consistently zero success rate
 *
 * Designed to be called:
 *   - On daemon startup
 *   - Periodically (e.g. every 24h via ScheduleManager)
 *   - Manually via `/sis cleanup`
 */

import type { ErrorSignatureDB, ErrorSignature } from './error-signature-db.js'

// ── Constants ──

/** Default retention period for retired signatures (days) */
const DEFAULT_RETENTION_DAYS = 90

/** Signatures with this many occurrences and 0 successes → auto-retire */
const ZERO_SUCCESS_THRESHOLD = 10

/** Levenshtein distance threshold for near-duplicate detection */
const SIMILARITY_THRESHOLD = 0.8

// ── Types ──

export interface GCReport {
  /** Number of retired signatures removed */
  retiredRemoved: number
  /** Number of zero-success signatures auto-retired */
  zeroSuccessRetired: number
  /** Number of near-duplicate signatures merged */
  duplicatesMerged: number
  /** Total signatures before cleanup */
  before: number
  /** Total signatures after cleanup */
  after: number
}

// ── GC Engine ──

export class ImmuneMemoryGC {
  private errorDB: ErrorSignatureDB

  constructor(errorDB: ErrorSignatureDB) {
    this.errorDB = errorDB
  }

  /**
   * Run a full garbage collection cycle.
   *
   * @param retentionDays — days to retain retired signatures (default 90)
   * @returns GCReport with cleanup statistics
   */
  collect(retentionDays: number = DEFAULT_RETENTION_DAYS): GCReport {
    const before = this.errorDB.getStats().total

    // Phase 1: Remove old retired signatures
    const retiredRemoved = this.errorDB.cleanup(retentionDays)

    // Phase 2: Auto-retire zero-success signatures
    const zeroSuccessRetired = this.retireZeroSuccess()

    // Phase 3: Merge near-duplicates
    const duplicatesMerged = this.mergeDuplicates()

    const after = this.errorDB.getStats().total

    return {
      retiredRemoved,
      zeroSuccessRetired,
      duplicatesMerged,
      before,
      after,
    }
  }

  // ── Private ──

  /**
   * Auto-retire signatures that have been tried many times
   * but never succeeded. These are likely bad or outdated fixes.
   */
  private retireZeroSuccess(): number {
    let count = 0
    const active = this.errorDB.getActive()

    for (const sig of active) {
      if (
        sig.occurrences >= ZERO_SUCCESS_THRESHOLD &&
        sig.successCount === 0 &&
        sig.status === 'active'
      ) {
        this.errorDB.retire(sig.id)
        count++
      }
    }

    return count
  }

  /**
   * Merge near-duplicate signatures.
   * Two signatures are duplicates if they share the same toolName + category
   * and their patterns are textually similar (high substring overlap).
   *
   * The older signature absorbs the newer one's occurrence count.
   */
  private mergeDuplicates(): number {
    let count = 0
    const active = this.errorDB.getActive()
    const merged = new Set<string>()

    for (let i = 0; i < active.length; i++) {
      if (merged.has(active[i].id)) continue

      for (let j = i + 1; j < active.length; j++) {
        if (merged.has(active[j].id)) continue

        if (this.areSimilar(active[i], active[j])) {
          // Merge j into i (keep the older, more established one)
          this.merge(active[i], active[j])
          merged.add(active[j].id)
          count++
        }
      }
    }

    return count
  }

  /** Check if two signatures are similar enough to be merged. */
  private areSimilar(a: ErrorSignature, b: ErrorSignature): boolean {
    // Must share toolName and category
    if (a.toolName !== b.toolName) return false
    if (a.category !== b.category) return false

    // Check pattern similarity via substring containment
    const shorter = a.pattern.length < b.pattern.length ? a.pattern : b.pattern
    const longer = a.pattern.length < b.pattern.length ? b.pattern : a.pattern

    if (longer.includes(shorter)) return true

    // Check Levenshtein-like similarity
    const similarity = this.jaccardSimilarity(shorter, longer)
    return similarity >= SIMILARITY_THRESHOLD
  }

  /** Jaccard similarity on word tokens (simple and fast). */
  private jaccardSimilarity(a: string, b: string): number {
    const tokensA = new Set(a.toLowerCase().split(/\s+/))
    const tokensB = new Set(b.toLowerCase().split(/\s+/))

    let intersection = 0
    for (const t of tokensA) {
      if (tokensB.has(t)) intersection++
    }

    const union = tokensA.size + tokensB.size - intersection
    return union > 0 ? intersection / union : 0
  }

  /** Merge signature `from` into `to`. Retire `from`. */
  private merge(to: ErrorSignature, from: ErrorSignature): void {
    // Transfer occurrences
    to.occurrences += from.occurrences
    to.successCount += from.successCount
    to.successRate =
      to.occurrences > 0 ? to.successCount / to.occurrences : 1.0

    // Keep the earlier firstSeen
    if (from.firstSeen < to.firstSeen) {
      to.firstSeen = from.firstSeen
    }
    // Keep the later lastSeen
    if (from.lastSeen > to.lastSeen) {
      to.lastSeen = from.lastSeen
    }

    // Retire the absorbed signature
    this.errorDB.retire(from.id)
  }
}
