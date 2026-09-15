import { createHash } from 'node:crypto'

/**
 * HyperLogLog, for estimating distinct installs.
 *
 * The alternative — and what the existing Python collector does — is a plain
 * `set[str]` of install ids. That is not an aggregate at all: it is the day's
 * roster of who ran the CLI, one row per machine. Storing it would contradict
 * "dimensional aggregates only" in the most direct way possible, and it is the
 * one data structure an operator could not hand over without also handing over
 * a list of installs.
 *
 * A sketch keeps only the shape of the set. No id is retained, nothing can be
 * enumerated, and an id cannot be tested for membership — which is exactly why
 * it is the right structure here. The cost is an approximation.
 *
 * Registers are one byte each rather than bit-packed. At p=11 that is 2 KiB,
 * ~2.7 KiB after base64, per day; packing to 6 bits would save 25% of a file
 * that is already dominated by the dedup id list, in exchange for shift
 * arithmetic that has to be right in two directions (pack and unpack).
 */

/** log2 of the register count. m = 2^P = 2048, standard error ≈ 2.3%. */
const P = 11
const M = 1 << P

/**
 * Feed an install id into the sketch and return the updated register value.
 *
 * Split out so the merge in `mergeIn` can reuse the same hashing without
 * duplicating the rank computation.
 */
function registerIndexOf(input: string): { index: number; rank: number } {
  const digest = createHash('sha256').update(input).digest()
  // 64 bits is plenty: P bits select the register and the remaining ~53 carry
  // the rank, whose practical ceiling is far below that.
  const hash = digest.readBigUInt64BE(0)

  const index = Number(hash & BigInt(M - 1))
  const rest = hash >> BigInt(P)

  // Rank = position of the leftmost 1 in the remaining bits, 1-based, capped at
  // the number of bits available so an all-zero tail cannot overflow the byte.
  const rank = rest === 0n ? 64 - P : 64 - P - rest.toString(2).length + 1
  return { index, rank }
}

export interface HllState {
  /** Base64 of the register array, one byte per register. */
  readonly registers: string
}

export class Hll {
  #registers = new Uint8Array(M)

  static fromState(state: HllState | undefined): Hll {
    const hll = new Hll()
    if (!state) return hll
    try {
      const raw = Buffer.from(state.registers, 'base64')
      // A truncated or oversized blob is discarded wholesale rather than
      // partially applied: a half-restored sketch silently underestimates, and
      // an estimate nobody can trust is worse than one that starts over.
      if (raw.length === M) hll.#registers.set(raw)
    } catch {
      /* leave empty */
    }
    return hll
  }

  add(id: string): void {
    if (id.length === 0) return
    const { index, rank } = registerIndexOf(id)
    const current = this.#registers[index]
    if (current !== undefined && rank > current) this.#registers[index] = rank
  }

  /** Merge another sketch's registers in. Used when a day file is re-read. */
  mergeIn(other: Hll): void {
    for (let i = 0; i < M; i++) {
      const a = this.#registers[i]
      const b = other.#registers[i]
      if (a !== undefined && b !== undefined && b > a) this.#registers[i] = b
    }
  }

  /**
   * Estimated distinct count.
   *
   * Includes the linear-counting correction for the small-range regime, which
   * matters here: a deployment with a few hundred installs would otherwise get
   * the raw harmonic estimate, which is biased high exactly where the numbers
   * are small enough to be read literally.
   */
  estimate(): number {
    const alpha = 0.7213 / (1 + 1.079 / M)
    let sum = 0
    let zeros = 0
    for (let i = 0; i < M; i++) {
      const value = this.#registers[i] ?? 0
      sum += 2 ** -value
      if (value === 0) zeros++
    }

    const raw = (alpha * M * M) / sum
    if (raw <= 2.5 * M && zeros > 0) return Math.round(M * Math.log(M / zeros))
    return Math.round(raw)
  }

  toState(): HllState {
    return { registers: Buffer.from(this.#registers).toString('base64') }
  }
}
