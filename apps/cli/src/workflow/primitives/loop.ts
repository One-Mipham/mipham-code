import { parallel } from './parallel'

/**
 * loopUntilConvergence() — workflow primitive for iterative discovery with
 * deduplication, adversarial verification, and convergence detection.
 *
 * Orchestrates multiple "finders" over successive rounds until no new items
 * are discovered for `dryRounds` consecutive rounds (convergence), or
 * `maxRounds` is reached (cutoff).
 *
 * Each item is keyed by `keyFn` for deduplication across rounds. If a
 * `verify` function is provided, only items that survive verification
 * enter the confirmed set — but all seen items (even those that fail
 * verification) are tracked in the seen-set to prevent re-discovery.
 */

export interface VerifyVote {
  real: boolean
  reason: string
}

export interface VerifyResult<T = unknown> {
  finding: T
  survives: boolean
  votes: VerifyVote[]
  score: number
}

export interface LoopUntilConvergenceResult<T> {
  confirmed: T[]
  totalSeen: number
  rounds: number
  converged: boolean
}

export interface LoopUntilConvergenceOpts<T> {
  finders: Array<() => Promise<{ items: T[] } | null>>
  keyFn: (item: T) => string
  verify?: (item: T) => Promise<VerifyResult<T>>
  dryRounds?: number
  maxRounds?: number
}

export async function loopUntilConvergence<T>(
  opts: LoopUntilConvergenceOpts<T>,
): Promise<LoopUntilConvergenceResult<T>> {
  const dryRounds = opts.dryRounds ?? 2
  const maxRounds = opts.maxRounds ?? 20

  const seen = new Set<string>()
  const confirmed: T[] = []
  let dry = 0
  let rounds = 0

  while (dry < dryRounds && rounds < maxRounds) {
    rounds++

    // FAN OUT: all finders run in parallel
    const raw = await parallel(opts.finders.map((f) => () => f()))

    // EDGE LOGIC: flatMap + dedup (pure JS, zero tokens)
    const items: T[] = []
    for (const result of raw) {
      if (result && result.items) {
        items.push(...result.items)
      }
    }

    // Dedup against SEEN set, not confirmed
    const fresh = items.filter((item) => {
      const key = opts.keyFn(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    if (fresh.length === 0) {
      dry++ // no new unique items → trending toward convergence
      continue
    }

    dry = 0 // new items found → reset dry counter

    // VERIFY: optional quality gate
    if (opts.verify) {
      const judged = await parallel(fresh.map((item) => () => opts.verify!(item)))
      for (const j of judged) {
        if (j && j.survives) {
          confirmed.push(j.finding as T)
        }
      }
    } else {
      confirmed.push(...fresh)
    }
  }

  return {
    confirmed,
    totalSeen: seen.size,
    rounds,
    converged: dry >= dryRounds,
  }
}
