/**
 * verify() and judge() — workflow primitives for adversarial verification,
 * multi-perspective review, and multi-judge evaluation.
 *
 * verify() supports 3 modes:
 *   - adversarial: N skeptics try to refute the finding (majority wins)
 *   - perspective:  N lenses each evaluate from a specific angle (at least 1 confirms)
 *   - consensus:    N voters must unanimously agree
 *
 * judge() evaluates N attempts by M judges, computes average scores,
 * picks the winner, and optionally synthesizes a final result.
 */

import { workflowAgent } from './agent'
import { parallel } from './parallel'
import type { WorkflowAgentOpts } from './agent'

// Agent function signature matching the sandbox-injected pattern:
// (prompt, opts?) → result. In production, the workflow runtime binds
// ProviderRegistry + ToolRegistry into a function of this shape and
// injects it via _mockAgent.
type AgentFn = (prompt: string, opts?: WorkflowAgentOpts) => Promise<unknown>

// ── Types ──

export interface VerifyResult {
  finding: unknown
  survives: boolean
  votes: Array<{ real: boolean; reason: string; lens?: string }>
  score: number
}

export type VerifyMode = 'adversarial' | 'perspective' | 'consensus'

export interface VerifyOpts {
  mode: VerifyMode
  skeptics?: number // adversarial: default 3
  lenses?: string[] // perspective: e.g. ['correctness', 'security']
  voters?: number // consensus: default 3
  threshold?: number
  schema: Record<string, unknown>
  /** Test-only: inject a mock agent function. When not provided, falls back to workflowAgent. */
  _mockAgent?: (prompt: string, opts?: WorkflowAgentOpts) => Promise<unknown>
}

interface VerdictVote {
  real: boolean
  reason: string
  lens?: string
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

export interface JudgeOpts {
  criteria: string[]
  judges?: number // default: 3
  synthesize?: boolean // default: true
  schema: Record<string, unknown>
  /** Test-only: inject a mock agent function. */
  _mockAgent?: (prompt: string, opts?: WorkflowAgentOpts) => Promise<unknown>
}

// ── Helpers ──

function defaultThreshold(mode: VerifyMode, total: number): number {
  if (mode === 'consensus') return total // all must agree
  if (mode === 'perspective') return 1 // at least one lens confirms
  return Math.ceil(total / 2) // adversarial: majority
}

// ── verify() ──

export async function verify(
  finding: unknown,
  opts: VerifyOpts,
): Promise<VerifyResult> {
  // Prefer the test hook (_mockAgent), fall back to workflowAgent.
  // In production sandbox usage, _mockAgent is set to the pre-bound agent
  // function injected by the workflow runtime.
  const agentFn: AgentFn =
    opts._mockAgent ?? (workflowAgent as unknown as AgentFn)
  const mode = opts.mode

  const findingStr = JSON.stringify(finding, null, 2)
  const schemaDesc = JSON.stringify(opts.schema)

  let prompts: Array<{ prompt: string; lens?: string }>

  switch (mode) {
    case 'adversarial': {
      const count = opts.skeptics ?? 3
      prompts = Array.from({ length: count }, (_, i) => ({
        prompt:
          `You are a skeptical reviewer (skeptic #${i + 1}). Try to REFUTE this finding. Default to real=false if uncertain.\n\n` +
          `Finding:\n${findingStr}\n\nReturn JSON matching this schema:\n${schemaDesc}`,
      }))
      break
    }
    case 'perspective': {
      const lenses = opts.lenses ?? ['correctness']
      prompts = lenses.map((lens) => ({
        prompt:
          `Judge this finding through the "${lens}" lens. Is it valid from this perspective?\n\n` +
          `Finding:\n${findingStr}\n\nReturn JSON matching this schema:\n${schemaDesc}`,
        lens,
      }))
      break
    }
    case 'consensus': {
      const count = opts.voters ?? 3
      prompts = Array.from({ length: count }, () => ({
        prompt:
          `Is this finding correct? Be honest and critical. Vote real=true only if you are fully convinced.\n\n` +
          `Finding:\n${findingStr}\n\nReturn JSON matching this schema:\n${schemaDesc}`,
      }))
      break
    }
  }

  // Fan out all agent calls concurrently
  const rawVotes = await parallel(
    prompts.map(
      (p) => () =>
        agentFn(p.prompt, { schema: opts.schema as WorkflowAgentOpts['schema'] }),
    ),
  )

  // Filter out failed agents (null) and build vote objects
  const votes: VerdictVote[] = []
  for (let i = 0; i < rawVotes.length; i++) {
    const v = rawVotes[i]
    if (v && typeof v === 'object') {
      const vote = v as Record<string, unknown>
      votes.push({
        real: Boolean(vote.real),
        reason: String(vote.reason ?? ''),
        lens: prompts[i]?.lens,
      })
    }
  }

  const threshold = opts.threshold ?? defaultThreshold(mode, votes.length)
  const realCount = votes.filter((v) => v.real).length
  const survives = realCount >= threshold

  return {
    finding,
    survives,
    votes,
    score: votes.length > 0 ? realCount / votes.length : 0,
  }
}

// ── judge() ──

export async function judge(
  attempts: unknown[],
  opts: JudgeOpts,
): Promise<JudgeResult> {
  // Prefer the test hook, fall back to workflowAgent.
  const agentFn: AgentFn =
    opts._mockAgent ?? (workflowAgent as unknown as AgentFn)
  const judgeCount = opts.judges ?? 3
  const schemaDesc = JSON.stringify(opts.schema)

  // Phase 1: each judge scores each attempt
  interface ScoreEntry {
    attemptIndex: number
    judgeIndex: number
    criteria: Record<string, number>
    total: number
    notes: string
  }

  // Build the cross-product of judges × attempts
  const scorePrompts: Array<{
    attempt: unknown
    attemptIndex: number
    judgeIndex: number
  }> = []
  for (let ji = 0; ji < judgeCount; ji++) {
    for (let ai = 0; ai < attempts.length; ai++) {
      scorePrompts.push({
        attempt: attempts[ai],
        attemptIndex: ai,
        judgeIndex: ji,
      })
    }
  }

  // Fan out all scoring calls concurrently
  const rawScores = await parallel(
    scorePrompts.map((sp) => () =>
      agentFn(
        `You are judge #${sp.judgeIndex + 1}. Score this attempt against the criteria: ${opts.criteria.join(', ')}.\n\n` +
          `Attempt:\n${JSON.stringify(sp.attempt, null, 2)}\n\n` +
          `Return JSON matching this schema:\n${schemaDesc}`,
        { schema: opts.schema as WorkflowAgentOpts['schema'] },
      ),
    ),
  )

  // Parse and validate each score result
  const scores: ScoreEntry[] = []
  for (let i = 0; i < rawScores.length; i++) {
    const raw = rawScores[i]
    const sp = scorePrompts[i]!
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>
      const criteriaObj = (obj.scores as Record<string, number>) ?? {}
      const total = Object.values(criteriaObj).reduce(
        (sum, v) => sum + (typeof v === 'number' ? v : 0),
        0,
      )
      scores.push({
        attemptIndex: sp.attemptIndex,
        judgeIndex: sp.judgeIndex,
        criteria: criteriaObj,
        total,
        notes: String(obj.notes ?? ''),
      })
    }
  }

  // Compute winner: highest average total across judges
  const attemptTotals = new Map<number, number>()
  const attemptCounts = new Map<number, number>()
  for (const s of scores) {
    attemptTotals.set(
      s.attemptIndex,
      (attemptTotals.get(s.attemptIndex) ?? 0) + s.total,
    )
    attemptCounts.set(
      s.attemptIndex,
      (attemptCounts.get(s.attemptIndex) ?? 0) + 1,
    )
  }

  let winnerIndex = 0
  let bestAvg = -Infinity
  for (const [idx, total] of attemptTotals) {
    const count = attemptCounts.get(idx) ?? 1
    const avg = total / count
    if (avg > bestAvg) {
      bestAvg = avg
      winnerIndex = idx
    }
  }

  // Phase 2: optional synthesis
  let synthesis: string | undefined
  if (opts.synthesize !== false) {
    const winner = attempts[winnerIndex]
    const runnerUps = attempts
      .map((a, i) => ({ attempt: a, index: i }))
      .filter((e) => e.index !== winnerIndex)

    const synthPrompt =
      `Synthesize the final result from the WINNING approach, grafting the best ideas from runner-ups.\n\n` +
      `WINNER:\n${JSON.stringify(winner, null, 2)}\n\n` +
      `RUNNER-UPS:\n${JSON.stringify(runnerUps, null, 2)}\n\n` +
      `Provide a comprehensive synthesis combining the winner's structure with the best elements from other approaches.`

    const synthResult = await agentFn(synthPrompt)
    if (typeof synthResult === 'string') {
      synthesis = synthResult
    } else if (
      synthResult &&
      typeof synthResult === 'object' &&
      'synthesis' in synthResult
    ) {
      synthesis = String((synthResult as Record<string, unknown>).synthesis)
    }
  }

  return {
    winner: attempts[winnerIndex],
    winnerIndex,
    scores,
    synthesis,
  }
}
