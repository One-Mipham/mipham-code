/**
 * verify() and judge() — workflow primitives for adversarial verification,
 * multi-perspective review, and multi-judge evaluation.
 *
 * This is a STUB file created in Task 1.1 (TDD RED phase).
 * Real implementation comes in Task 1.2.
 */

// ----- Types -----

export interface VerifyOptions {
  mode: 'adversarial' | 'perspective' | 'consensus'
  /** Number of skeptics (adversarial) or voters (consensus) */
  skeptics?: number
  voters?: number
  /** Perspectives/lenses to evaluate from */
  lenses?: string[]
  /** Minimum number of "real" votes required to survive */
  threshold?: number
  /** JSON Schema for the agent response validation */
  schema?: Record<string, unknown>
  /** Test-only: inject a mock agent */
  _mockAgent?: (...args: unknown[]) => Promise<unknown>
}

export interface VerifyResult {
  finding: unknown
  survives: boolean
  votes: Array<{ real: boolean; reason: string; lens?: string }>
  score: number
}

export interface JudgeOptions {
  criteria: string[]
  judges: number
  synthesize?: boolean
  schema?: Record<string, unknown>
  /** Test-only: inject a mock agent */
  _mockAgent?: (...args: unknown[]) => Promise<unknown>
}

export interface JudgeResult {
  winner: unknown
  winnerIndex: number
  scores: Array<{
    attemptIndex: number
    judgeIndex: number
    criteria: Record<string, number>
    total: number
    notes: string
  }>
  synthesis?: string
}

// ----- Stub implementations (TDD RED phase) -----

export async function verify(
  _finding: unknown,
  _options: VerifyOptions,
): Promise<VerifyResult> {
  throw new Error('verify() not implemented — RED phase of TDD, see Task 1.2')
}

export async function judge(
  _attempts: unknown[],
  _options: JudgeOptions,
): Promise<JudgeResult> {
  throw new Error('judge() not implemented — RED phase of TDD, see Task 1.2')
}
