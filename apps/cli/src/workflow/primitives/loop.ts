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
  _opts: LoopUntilConvergenceOpts<T>,
): Promise<LoopUntilConvergenceResult<T>> {
  throw new Error('not implemented')
}
