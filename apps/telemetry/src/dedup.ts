/**
 * Event de-duplication, biased to over-count.
 *
 * The client delivers at least once and has no cross-process lock:
 * `transport.ts` reads the queue, sends every event, then acks the whole batch
 * once, so a process killed mid-flush resends, and two concurrent CLI launches
 * both flush the same file. Duplicates are therefore normal, not exceptional.
 *
 * **Why the bias matters.** Downstream, these counts decide which features get
 * deleted (`ROADMAP.md` T4 step 4: "用 T1 的遥测数据投票 → 删掉没人用的"). That is
 * an *existence* judgement, not a magnitude one, and the two failure directions
 * are not symmetric:
 *
 *   - counting a duplicate twice inflates a number for a feature that already
 *     appeared — the feature is still visibly used, and a review that looks at
 *     magnitude is merely misled;
 *   - dropping a genuinely unique event makes a live feature look unused, and
 *     the review deletes working code. That is not recoverable by re-reading the
 *     data.
 *
 * So the only branch that discards is "this id is *definitely* one we counted
 * before". Everything uncertain is counted. An id that was evicted from the
 * window is therefore **new**, not a duplicate — the error is always upward.
 *
 * Deliberately absent: a Bloom filter. The usual argument for one is memory, but
 * the memory that actually bounds this is the cap itself, and the cap already
 * gives the identical one-sided bias. A 1 MiB sketch would roughly double the
 * size of each day's file to extend a window this deployment will never reach,
 * and it would add a tunable false-positive rate needing its own empirical test.
 * The cap is sized well above any plausible daily peak instead.
 */

/**
 * Ids tracked per day before the oldest are evicted.
 *
 * Sized at roughly ten times a plausible daily peak for this deployment (a few
 * thousand events), so eviction is a safety valve rather than a routine event.
 * Raising it costs file size linearly; lowering it only ever causes re-counting,
 * which is the safe direction.
 */
export const MAX_TRACKED_IDS = 20_000

/** Serialised form, embedded in the daily aggregate file. */
export interface DeduperState {
  /** Ids in arrival order; the head is evicted first. */
  readonly ids: readonly string[]
  /** How many ids have been evicted since the day began. */
  readonly evicted: number
}

export type DedupVerdict = 'new' | 'duplicate'

export class Deduper {
  #set = new Set<string>()
  /** Arrival order, kept so eviction drops the oldest rather than an arbitrary id. */
  #order: string[] = []
  #evicted = 0

  /** Restore from a daily file. Unknown/absent state starts empty. */
  static fromState(state: DeduperState | undefined): Deduper {
    const deduper = new Deduper()
    if (!state) return deduper
    for (const id of state.ids) {
      if (typeof id !== 'string' || deduper.#set.has(id)) continue
      deduper.#set.add(id)
      deduper.#order.push(id)
    }
    deduper.#evicted = Number.isSafeInteger(state.evicted) && state.evicted >= 0 ? state.evicted : 0
    return deduper
  }

  /**
   * Classify an id and, when it is new, remember it.
   *
   * Single method rather than `has()` + `add()` so no caller can classify an id
   * as new and then forget to record it — which would silently disable dedup
   * for that path.
   */
  check(id: string): DedupVerdict {
    if (this.#set.has(id)) return 'duplicate'

    this.#set.add(id)
    this.#order.push(id)

    if (this.#order.length > MAX_TRACKED_IDS) {
      const dropped = this.#order.shift()
      if (dropped !== undefined) {
        this.#set.delete(dropped)
        this.#evicted++
      }
    }
    return 'new'
  }

  /** Ids evicted so far. Non-zero means some re-deliveries will be re-counted. */
  get evicted(): number {
    return this.#evicted
  }

  get size(): number {
    return this.#set.size
  }

  toState(): DeduperState {
    return { ids: this.#order, evicted: this.#evicted }
  }
}
