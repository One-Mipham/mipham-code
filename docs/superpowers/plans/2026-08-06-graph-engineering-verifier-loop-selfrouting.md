# Graph Engineering: Verifier, Loop, Self-Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three new workflow primitives (verify/judge/loopUntilConvergence) to Mipham Code's workflow runtime, then enable auto-workflow-generation via expanded tool description, slash commands, and system instructions.

**Architecture:** Each primitive is a standalone TypeScript module in `src/workflow/primitives/` that composes existing `parallel()` and `workflowAgent()` — zero new dependencies. The runtime injects them into the workflow sandbox alongside the existing primitives. Self-routing is achieved by expanding the Workflow tool description into a complete guide that any LLM can read to generate orchestration scripts.

**Tech Stack:** TypeScript 5.5+ (strict), Vitest 3, Bun/Node.js 22+, existing SubAgent + ProviderRegistry

## Global Constraints

- All code in `apps/cli/src/workflow/` and `apps/cli/test/workflow/`
- Must pass `pnpm typecheck` (TypeScript strict)
- Must pass `pnpm test` (708 existing tests + new ones)
- Must pass `pnpm lint` (ESLint flat config) and `pnpm format` (Prettier)
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- Zero new npm dependencies
- Public API naming: `loopUntilConvergence` (NOT `loopUntilDry` — IP risk)
- Workflow tool description must be original content, not copied from Claude Code

---

## File Map

```
apps/cli/
├── src/workflow/
│   ├── primitives/
│   │   ├── verify.ts          ← CREATE: verify() + judge()
│   │   ├── loop.ts            ← CREATE: loopUntilConvergence()
│   │   ├── agent.ts           ← [existing] workflowAgent()
│   │   ├── parallel.ts        ← [existing] parallel()
│   │   └── pipeline.ts        ← [existing] pipeline()
│   └── runtime.ts             ← MODIFY: inject verify/judge/loopUntilConvergence
├── src/tools/agent/
│   └── workflow.ts            ← MODIFY: expand tool description + add args params
├── src/ui/
│   └── commands.ts            ← MODIFY: /workflow <task>, /workflow save, /workflow run
├── src/core/
│   └── instructions.ts        ← MODIFY: inject auto-generation system instruction
├── skills/workflows/          ← CREATE directory
│   ├── audit.js               ← CREATE: diamond + verify template
│   ├── research.js            ← CREATE: diamond + verify template
│   ├── migrate.js             ← CREATE: pipeline + verify template
│   ├── review.js              ← CREATE: fan-out + judge template
│   ├── hunt.js                ← CREATE: loopUntilConvergence template
│   └── judge.js               ← CREATE: judge panel template
└── test/workflow/
    ├── verify.test.ts         ← CREATE: verify() + judge() tests
    └── loop.test.ts           ← CREATE: loopUntilConvergence() tests
```

---

## Phase 1: Step 09 — Verifier Primitives

### Task 1.1: Write verify.test.ts

**Files:**
- Create: `apps/cli/test/workflow/verify.test.ts`

**Interfaces:**
- Produces: Test file for `verify()` and `judge()` — imported in Task 1.3

- [ ] **Step 1: Create test file with mock agent infrastructure**

```typescript
import { describe, it, expect, vi } from 'vitest'

// We test verify() and judge() as pure functions by mocking the agent primitive.
// The real agent is tested in integration via runtime.test.ts.
// Here we inject a mock agent that returns pre-baked responses.

interface VerifyResult {
  finding: unknown
  survives: boolean
  votes: Array<{ real: boolean; reason: string; lens?: string }>
  score: number
}

interface JudgeResult {
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
```

- [ ] **Step 2: Write adversarial verify tests**

```typescript
describe('verify() — adversarial mode', () => {
  it('survives when majority of skeptics vote real', async () => {
    // We'll import verify after creating it in Task 1.2
    // For now, define the expected behavior:
    // verify({ title: 'bug' }, { mode: 'adversarial', skeptics: 3, threshold: 2, schema: VERDICT })
    // → 2 skeptics say real, 1 says fake → survives=true, score=0.67
    const { verify } = await import('../../src/workflow/primitives/verify')

    const mockAgent = vi.fn()
      .mockResolvedValueOnce({ real: true, reason: 'confirmed: the bug is real' })
      .mockResolvedValueOnce({ real: true, reason: 'confirmed: reproduces consistently' })
      .mockResolvedValueOnce({ real: false, reason: 'refuted: expected behavior' })

    const result = await verify(
      { title: 'crash on null input', file: 'app.ts', line: 42 },
      {
        mode: 'adversarial',
        skeptics: 3,
        threshold: 2,
        schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] },
        _mockAgent: mockAgent,
      },
    )

    expect(result.survives).toBe(true)
    expect(result.score).toBe(2 / 3)
    expect(result.votes).toHaveLength(3)
    expect(result.votes.filter(v => v.real)).toHaveLength(2)
  })

  it('fails when minority of skeptics vote real', async () => {
    const { verify } = await import('../../src/workflow/primitives/verify')

    const mockAgent = vi.fn()
      .mockResolvedValueOnce({ real: false, reason: 'cannot reproduce' })
      .mockResolvedValueOnce({ real: true, reason: 'looks real' })
      .mockResolvedValueOnce({ real: false, reason: 'expected behavior per spec' })

    const result = await verify(
      { title: 'alleged memory leak' },
      {
        mode: 'adversarial',
        skeptics: 3,
        threshold: 2,
        schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] },
        _mockAgent: mockAgent,
      },
    )

    expect(result.survives).toBe(false)
    expect(result.score).toBe(1 / 3)
  })

  it('handles a failed skeptic (null result)', async () => {
    const { verify } = await import('../../src/workflow/primitives/verify')

    const mockAgent = vi.fn()
      .mockResolvedValueOnce({ real: true, reason: 'real bug' })
      .mockResolvedValueOnce(null) // simulated agent failure
      .mockResolvedValueOnce({ real: true, reason: 'confirmed' })

    const result = await verify(
      { title: 'test' },
      {
        mode: 'adversarial',
        skeptics: 3,
        threshold: 2,
        schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] },
        _mockAgent: mockAgent,
      },
    )

    // 2 out of 2 valid votes are real → survives
    expect(result.survives).toBe(true)
    expect(result.votes).toHaveLength(2) // null filtered out
  })
})
```

- [ ] **Step 3: Write perspective verify tests**

```typescript
describe('verify() — perspective mode', () => {
  it('survives when enough lenses confirm', async () => {
    const { verify } = await import('../../src/workflow/primitives/verify')

    const mockAgent = vi.fn()
      .mockResolvedValueOnce({ real: true, reason: 'correctness: logic is sound' })
      .mockResolvedValueOnce({ real: true, reason: 'security: no vulnerability' })
      .mockResolvedValueOnce({ real: false, reason: 'performance: O(n²) is slow' })
      .mockResolvedValueOnce({ real: true, reason: 'repro: consistently reproducible' })

    const result = await verify(
      { title: 'sorting bug' },
      {
        mode: 'perspective',
        lenses: ['correctness', 'security', 'performance', 'reproducibility'],
        threshold: 2,
        schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] },
        _mockAgent: mockAgent,
      },
    )

    expect(result.survives).toBe(true)
    expect(result.votes).toHaveLength(4)
    expect(result.votes[0]!.lens).toBe('correctness')
    expect(result.votes[2]!.lens).toBe('performance')
  })
})
```

- [ ] **Step 4: Write consensus verify tests**

```typescript
describe('verify() — consensus mode', () => {
  it('survives only when ALL voters agree', async () => {
    const { verify } = await import('../../src/workflow/primitives/verify')

    // All 3 say real → survives
    const allReal = vi.fn()
      .mockResolvedValueOnce({ real: true, reason: 'ok' })
      .mockResolvedValueOnce({ real: true, reason: 'ok' })
      .mockResolvedValueOnce({ real: true, reason: 'ok' })

    const r1 = await verify(
      { title: 'clear bug' },
      { mode: 'consensus', voters: 3, schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] }, _mockAgent: allReal },
    )
    expect(r1.survives).toBe(true)
    expect(r1.score).toBe(1.0)

    // 2 of 3 say real → fails consensus
    const twoReal = vi.fn()
      .mockResolvedValueOnce({ real: true, reason: 'ok' })
      .mockResolvedValueOnce({ real: true, reason: 'ok' })
      .mockResolvedValueOnce({ real: false, reason: 'nope' })

    const r2 = await verify(
      { title: 'debatable' },
      { mode: 'consensus', voters: 3, schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] }, _mockAgent: mockAgent2 },
    )
    expect(r2.survives).toBe(false)
  })
})
```

- [ ] **Step 5: Write judge() tests**

```typescript
describe('judge()', () => {
  it('evaluates N attempts by M judges and picks winner', async () => {
    const { judge } = await import('../../src/workflow/primitives/verify')

    const attempts = [
      { name: 'approach-a', description: 'MVP-first' },
      { name: 'approach-b', description: 'risk-first' },
    ]

    // 3 judges × 2 attempts = 6 agent calls
    // Judge 0: prefers attempt 0
    // Judge 1: prefers attempt 1
    // Judge 2: prefers attempt 0 → winner = attempt 0
    const mockAgent = vi.fn()
      .mockResolvedValueOnce({ scores: { completeness: 8, correctness: 9, elegance: 7 }, notes: 'solid' })
      .mockResolvedValueOnce({ scores: { completeness: 5, correctness: 6, elegance: 8 }, notes: 'skimpy' })
      .mockResolvedValueOnce({ scores: { completeness: 6, correctness: 7, elegance: 6 }, notes: 'ok' })
      .mockResolvedValueOnce({ scores: { completeness: 9, correctness: 8, elegance: 7 }, notes: 'better' })
      .mockResolvedValueOnce({ scores: { completeness: 8, correctness: 9, elegance: 9 }, notes: 'best' })
      .mockResolvedValueOnce({ scores: { completeness: 4, correctness: 5, elegance: 6 }, notes: 'weak' })

    const result = await judge(attempts, {
      criteria: ['completeness', 'correctness', 'elegance'],
      judges: 3,
      synthesize: false,
      schema: {
        type: 'object',
        properties: {
          scores: {
            type: 'object',
            properties: {
              completeness: { type: 'number' },
              correctness: { type: 'number' },
              elegance: { type: 'number' },
            },
            required: ['completeness', 'correctness', 'elegance'],
          },
          notes: { type: 'string' },
        },
        required: ['scores', 'notes'],
      },
      _mockAgent: mockAgent,
    })

    expect(result.winner).toEqual(attempts[0])
    expect(result.scores).toHaveLength(6) // 2 attempts × 3 judges
    expect(result.synthesis).toBeUndefined()
  })

  it('synthesizes when requested', async () => {
    const { judge } = await import('../../src/workflow/primitives/verify')

    const attempts = [{ name: 'plan-a' }, { name: 'plan-b' }]

    const mockAgent = vi.fn()
      // 2 judges × 2 attempts = 4 score calls
      .mockResolvedValueOnce({ scores: { quality: 8 }, notes: 'good' })
      .mockResolvedValueOnce({ scores: { quality: 5 }, notes: 'meh' })
      .mockResolvedValueOnce({ scores: { quality: 7 }, notes: 'decent' })
      .mockResolvedValueOnce({ scores: { quality: 6 }, notes: 'ok' })
      // 1 synthesis call
      .mockResolvedValueOnce('Synthesized: combine plan-a structure with plan-b simplicity')

    const result = await judge(attempts, {
      criteria: ['quality'],
      judges: 2,
      synthesize: true,
      schema: {
        type: 'object',
        properties: {
          scores: { type: 'object', properties: { quality: { type: 'number' } }, required: ['quality'] },
          notes: { type: 'string' },
        },
        required: ['scores', 'notes'],
      },
      _mockAgent: mockAgent,
    })

    expect(result.synthesis).toBe('Synthesized: combine plan-a structure with plan-b simplicity')
    expect(result.winner).toEqual(attempts[0]) // plan-a: 8+7=15 vs plan-b: 5+6=11
  })
})
```

- [ ] **Step 6: Commit test file (tests will fail — no implementation yet)**

```bash
git add apps/cli/test/workflow/verify.test.ts
git commit -m "test: add verify() and judge() test suite (RED)"
```

---

### Task 1.2: Implement verify.ts

**Files:**
- Create: `apps/cli/src/workflow/primitives/verify.ts`

**Interfaces:**
- Consumes: `workflowAgent` from `./agent`, `parallel` from `./parallel`
- Produces: `verify(finding, opts)` → `VerifyResult`, `judge(attempts, opts)` → `JudgeResult`

- [ ] **Step 1: Create verify.ts with full implementation**

```typescript
import { workflowAgent } from './agent'
import { parallel } from './parallel'
import type { WorkflowAgentOpts } from './agent'

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
  skeptics?: number    // adversarial: default 3
  lenses?: string[]    // perspective: e.g. ['correctness', 'security']
  voters?: number      // consensus: default 3
  threshold?: number
  schema: object
  _mockAgent?: (prompt: string, opts?: WorkflowAgentOpts) => Promise<unknown>  // test-only
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
  judges?: number       // default: 3
  synthesize?: boolean  // default: true
  schema: object
  _mockAgent?: (prompt: string, opts?: WorkflowAgentOpts) => Promise<unknown>  // test-only
}

// ── Helpers ──

function defaultThreshold(mode: VerifyMode, total: number): number {
  if (mode === 'consensus') return total   // all must agree
  if (mode === 'perspective') return 1     // at least one lens confirms
  return Math.ceil(total / 2)              // adversarial: majority
}

// ── verify() ──

export async function verify(
  finding: unknown,
  opts: VerifyOpts,
): Promise<VerifyResult> {
  const agentFn = opts._mockAgent ?? workflowAgent
  const mode = opts.mode

  const findingStr = JSON.stringify(finding, null, 2)
  const schemaDesc = JSON.stringify(opts.schema)

  let prompts: Array<{ prompt: string; lens?: string }>

  switch (mode) {
    case 'adversarial': {
      const count = opts.skeptics ?? 3
      prompts = Array.from({ length: count }, (_, i) => ({
        prompt: `You are a skeptical reviewer (skeptic #${i + 1}). Try to REFUTE this finding. Default to refuted=true if uncertain.\n\nFinding:\n${findingStr}\n\nReturn JSON matching this schema:\n${schemaDesc}`,
      }))
      break
    }
    case 'perspective': {
      const lenses = opts.lenses ?? ['correctness']
      prompts = lenses.map((lens) => ({
        prompt: `Judge this finding through the "${lens}" lens. Is it valid from this perspective?\n\nFinding:\n${findingStr}\n\nReturn JSON matching this schema:\n${schemaDesc}`,
        lens,
      }))
      break
    }
    case 'consensus': {
      const count = opts.voters ?? 3
      prompts = Array.from({ length: count }, (_, i) => ({
        prompt: `Is this finding correct? Be honest and critical. Vote real=true only if you are fully convinced.\n\nFinding:\n${findingStr}\n\nReturn JSON matching this schema:\n${schemaDesc}`,
      }))
      break
    }
  }

  const rawVotes = await parallel(
    prompts.map((p) => () => agentFn(p.prompt, { schema: opts.schema })),
  )

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
  const agentFn = opts._mockAgent ?? workflowAgent
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

  const scorePrompts: Array<{ attempt: unknown; attemptIndex: number; judgeIndex: number }> = []
  for (let ji = 0; ji < judgeCount; ji++) {
    for (let ai = 0; ai < attempts.length; ai++) {
      scorePrompts.push({ attempt: attempts[ai], attemptIndex: ai, judgeIndex: ji })
    }
  }

  const rawScores = await parallel(
    scorePrompts.map((sp) => () =>
      agentFn(
        `You are judge #${sp.judgeIndex + 1}. Score this attempt against the criteria: ${opts.criteria.join(', ')}.\n\nAttempt:\n${JSON.stringify(sp.attempt, null, 2)}\n\nReturn JSON matching this schema:\n${schemaDesc}`,
        { schema: opts.schema },
      ),
    ),
  )

  const scores: ScoreEntry[] = []
  for (let i = 0; i < rawScores.length; i++) {
    const raw = rawScores[i]
    const sp = scorePrompts[i]!
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>
      const criteriaObj = (obj.scores as Record<string, number>) ?? {}
      const total = Object.values(criteriaObj).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0)
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
    attemptTotals.set(s.attemptIndex, (attemptTotals.get(s.attemptIndex) ?? 0) + s.total)
    attemptCounts.set(s.attemptIndex, (attemptCounts.get(s.attemptIndex) ?? 0) + 1)
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
    }
  }

  return {
    winner: attempts[winnerIndex],
    winnerIndex,
    scores,
    synthesis,
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd apps/cli && pnpm test test/workflow/verify.test.ts
```
Expected: All verify/judge tests PASS

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/workflow/primitives/verify.ts
git commit -m "feat: add verify() and judge() workflow primitives (Step 09)"
```

---

### Task 1.3: Inject verify + judge into runtime.ts

**Files:**
- Modify: `apps/cli/src/workflow/runtime.ts`

**Interfaces:**
- Consumes: `verify`, `judge` from `./primitives/verify`
- Produces: `verify` and `judge` available in workflow scripts as globals

- [ ] **Step 1: Add import and injection in runtime.ts**

In `apps/cli/src/workflow/runtime.ts`:

Add import at top (after existing imports):
```typescript
import { verify, judge } from './primitives/verify'
```

In the `runWorkflow` function, add `verify` and `judge` to the sandbox bindings.

Find this block (around lines 139-155):
```typescript
  const wrappedScript = `
    return (async () => {
      ${script}
    })()
  `

  // Execute in sandboxed context
  const scriptFn = new Function(
    'agent',
    'parallel',
    'pipeline',
    'phase',
    'log',
    'args',
    'budget',
    wrappedScript,
  )

  const result = await scriptFn(agent, parallel, pipeline, wrappedPhase, log, args, budget)
```

Replace with:
```typescript
  const wrappedScript = `
    return (async () => {
      ${script}
    })()
  `

  // Execute in sandboxed context
  const scriptFn = new Function(
    'agent',
    'parallel',
    'pipeline',
    'verify',
    'judge',
    'phase',
    'log',
    'args',
    'budget',
    wrappedScript,
  )

  const result = await scriptFn(agent, parallel, pipeline, verify, judge, wrappedPhase, log, args, budget)
```

- [ ] **Step 2: Run full test suite to check for regressions**

```bash
cd apps/cli && pnpm test
```
Expected: 708 existing tests + new verify tests all PASS

- [ ] **Step 3: Run typecheck**

```bash
cd apps/cli && pnpm typecheck
```
Expected: zero errors

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/workflow/runtime.ts
git commit -m "feat: inject verify() and judge() into workflow runtime sandbox"
```

---

## Phase 2: Step 11 — Convergence Loop

### Task 2.1: Write loop.test.ts

**Files:**
- Create: `apps/cli/test/workflow/loop.test.ts`

**Interfaces:**
- Produces: Test file for `loopUntilConvergence()` — imported in Task 2.2

- [ ] **Step 1: Create test file**

```typescript
import { describe, it, expect, vi } from 'vitest'

interface LoopUntilConvergenceResult<T> {
  confirmed: T[]
  totalSeen: number
  rounds: number
  converged: boolean
}
```

- [ ] **Step 2: Write convergence test**

```typescript
describe('loopUntilConvergence()', () => {
  it('converges naturally after consecutive dry rounds', async () => {
    const { loopUntilConvergence } = await import('../../src/workflow/primitives/loop')

    // Finder returns: round1=[a,b], round2=[c], round3=[] (dry), round4=[] (dry) → stop
    let round = 0
    const mockFinder = vi.fn(async () => {
      round++
      if (round === 1) return { items: [{ id: 'a' }, { id: 'b' }] }
      if (round === 2) return { items: [{ id: 'c' }] }
      return { items: [] } // rounds 3, 4, 5, ... — dry
    })

    const result = await loopUntilConvergence({
      finders: [mockFinder],
      keyFn: (item: { id: string }) => item.id,
      dryRounds: 2,
      maxRounds: 10,
    })

    expect(result.confirmed).toHaveLength(3) // a, b, c
    expect(result.totalSeen).toBe(3)
    expect(result.rounds).toBe(4) // 1,2 (found), 3 (dry), 4 (dry → stop)
    expect(result.converged).toBe(true)
  })

  it('deduplicates against seen-set (NOT confirmed-set)', async () => {
    const { loopUntilConvergence } = await import('../../src/workflow/primitives/loop')

    // Finder keeps returning the same items — but verify() rejects them
    // Key insight: they go into seen-set even when rejected, so no resurrection

    const mockFinder = vi.fn(async () => ({
      items: [{ id: 'x', desc: 'alleged bug' }],
    }))

    // verify always says "not real"
    const mockVerify = vi.fn(async (item: unknown) => ({
      finding: item,
      survives: false,
      votes: [{ real: false, reason: 'expected behavior' }],
      score: 0,
    }))

    const result = await loopUntilConvergence({
      finders: [mockFinder],
      keyFn: (item: { id: string }) => item.id,
      verify: mockVerify,
      dryRounds: 2,
      maxRounds: 10,
    })

    // Round 1: finder returns [x], verify rejects it, x → seen
    // Round 2: finder returns [x], already in seen → fresh=[] → dry++
    // Round 3: fresh=[] → dry++ → stop
    expect(result.confirmed).toHaveLength(0)    // nothing survived verify
    expect(result.totalSeen).toBe(1)             // x was seen once
    expect(result.rounds).toBe(3)                // converged, not infinite
    expect(result.converged).toBe(true)
    expect(mockVerify).toHaveBeenCalledTimes(1)  // only called once, not every round
  })

  it('stops at maxRounds when finder never runs dry', async () => {
    const { loopUntilConvergence } = await import('../../src/workflow/primitives/loop')

    let id = 0
    const mockFinder = vi.fn(async () => {
      id++
      return { items: [{ id: String(id), value: id }] } // always new
    })

    const result = await loopUntilConvergence({
      finders: [mockFinder],
      keyFn: (item: { id: string }) => item.id,
      dryRounds: 2,
      maxRounds: 5,
    })

    expect(result.rounds).toBe(5)
    expect(result.converged).toBe(false)
    expect(result.totalSeen).toBe(5)
    expect(result.confirmed).toHaveLength(5)
  })

  it('handles empty finder (first round dry)', async () => {
    const { loopUntilConvergence } = await import('../../src/workflow/primitives/loop')

    const mockFinder = vi.fn(async () => ({ items: [] }))

    const result = await loopUntilConvergence({
      finders: [mockFinder],
      keyFn: (item: { id: string }) => item.id,
      dryRounds: 2,
      maxRounds: 10,
    })

    expect(result.rounds).toBe(2) // 2 dry rounds → stop
    expect(result.confirmed).toHaveLength(0)
    expect(result.converged).toBe(true)
  })

  it('handles a failed finder (returns null)', async () => {
    const { loopUntilConvergence } = await import('../../src/workflow/primitives/loop')

    let called = 0
    const goodFinder = vi.fn(async () => {
      called++
      if (called === 1) return { items: [{ id: 'a' }] }
      return { items: [] }
    })
    const badFinder = vi.fn(async () => {
      throw new Error('finder crashed')
    })

    const result = await loopUntilConvergence({
      finders: [goodFinder, badFinder],
      keyFn: (item: { id: string }) => item.id,
      dryRounds: 2,
      maxRounds: 10,
    })

    // goodFinder found 'a' in round 1, then dry rounds → converge
    expect(result.confirmed).toHaveLength(1)
    expect(result.converged).toBe(true)
  })

  it('verify integration: only survivors go into confirmed', async () => {
    const { loopUntilConvergence } = await import('../../src/workflow/primitives/loop')

    const mockFinder = vi.fn(async () => ({
      items: [
        { id: 'real-bug', severity: 'high' },
        { id: 'false-alarm', severity: 'low' },
      ],
    }))

    const mockVerify = vi.fn(async (item: unknown) => {
      const obj = item as { id: string }
      return {
        finding: item,
        survives: obj.id === 'real-bug',
        votes: [{ real: obj.id === 'real-bug', reason: obj.id === 'real-bug' ? 'confirmed' : 'refuted' }],
        score: obj.id === 'real-bug' ? 1 : 0,
      }
    })

    const result = await loopUntilConvergence({
      finders: [mockFinder],
      keyFn: (item: { id: string }) => item.id,
      verify: mockVerify,
      dryRounds: 2,
    })

    expect(result.confirmed).toHaveLength(1)
    expect((result.confirmed[0] as { id: string }).id).toBe('real-bug')
    expect(result.totalSeen).toBe(2) // both were seen
  })
})
```

- [ ] **Step 2: Commit test file (tests will fail)**

```bash
git add apps/cli/test/workflow/loop.test.ts
git commit -m "test: add loopUntilConvergence() test suite (RED)"
```

---

### Task 2.2: Implement loop.ts

**Files:**
- Create: `apps/cli/src/workflow/primitives/loop.ts`

**Interfaces:**
- Consumes: `parallel` from `./parallel`, optionally `verify` from `./verify` (via callback)
- Produces: `loopUntilConvergence(opts)` → `LoopUntilConvergenceResult<T>`

- [ ] **Step 1: Create loop.ts**

```typescript
import { parallel } from './parallel'

// ── Types ──

export interface LoopUntilConvergenceOpts<T> {
  finders: Array<() => Promise<{ items: T[] } | null>>
  keyFn: (item: T) => string
  verify?: (item: T) => Promise<{ survives: boolean; finding: unknown }>
  dryRounds?: number   // default: 2
  maxRounds?: number   // default: 20
}

export interface LoopUntilConvergenceResult<T> {
  confirmed: T[]
  totalSeen: number
  rounds: number
  converged: boolean
}

// ── Implementation ──

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

    // ⚠️ Dedup against SEEN set, not confirmed
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
      const judged = await parallel(
        fresh.map((item) => () => opts.verify!(item)),
      )
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
```

- [ ] **Step 2: Run loop tests**

```bash
cd apps/cli && pnpm test test/workflow/loop.test.ts
```
Expected: All loop tests PASS

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/workflow/primitives/loop.ts
git commit -m "feat: add loopUntilConvergence() workflow primitive (Step 11)"
```

---

### Task 2.3: Inject loopUntilConvergence into runtime.ts

**Files:**
- Modify: `apps/cli/src/workflow/runtime.ts`

**Interfaces:**
- Consumes: `loopUntilConvergence` from `./primitives/loop`
- Produces: `loopUntilConvergence` available in workflow scripts

- [ ] **Step 1: Add import and injection**

Add import (after the verify/judge import from Phase 1):
```typescript
import { loopUntilConvergence } from './primitives/loop'
```

Update the `new Function` constructor to include `loopUntilConvergence`:
```typescript
  const scriptFn = new Function(
    'agent',
    'parallel',
    'pipeline',
    'verify',
    'judge',
    'loopUntilConvergence',
    'phase',
    'log',
    'args',
    'budget',
    wrappedScript,
  )

  const result = await scriptFn(
    agent, parallel, pipeline, verify, judge, loopUntilConvergence,
    wrappedPhase, log, args, budget,
  )
```

- [ ] **Step 2: Run full test suite**

```bash
cd apps/cli && pnpm test
```
Expected: All tests PASS (708 existing + verify + loop)

- [ ] **Step 3: Run typecheck**

```bash
cd apps/cli && pnpm typecheck
```
Expected: zero errors

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/workflow/runtime.ts
git commit -m "feat: inject loopUntilConvergence() into workflow runtime sandbox"
```

---

## Phase 3: Step 14 — Self-Routing

### Task 3.1: Expand Workflow tool description

**Files:**
- Modify: `apps/cli/src/tools/agent/workflow.ts`

**Interfaces:**
- Consumes: (none — description is a string literal)
- Produces: Updated `description` field, added `scriptPath`/`name`/`resumeFromRunId` params

- [ ] **Step 1: Replace the tool description with the expanded guide**

The current `description` field (~50 words) must be replaced. Locate:
```typescript
export const workflowTool: ToolDefinition = {
  name: 'Workflow',
  description:
    'Execute a multi-agent workflow script. The script uses agent(), parallel(), pipeline(), phase(), log(), args, budget primitives. ' +
    'Pass resumeFromRunId to resume a prior run — cached agent() calls are replayed from the journal, ' +
    'and only new/changed calls execute live.',
```

Replace `description` with:
```typescript
  description:
    'Execute a workflow script that orchestrates multiple subagents deterministically. ' +
    'Workflows run in the background — this tool returns immediately with a task ID, ' +
    'and a <task-notification> arrives when the workflow completes. Use /workflows to watch live progress.\n\n' +

    'A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), ' +
    'to be confident (independent perspectives and adversarial checks before committing), ' +
    'or to take on scale one context cannot hold (migrations, audits, broad sweeps). ' +
    'The script is where you encode that structure: what fans out, what verifies, what synthesizes.\n\n' +

    'ONLY call this tool when the task benefits from multi-agent orchestration. ' +
    'For a simple single-agent lookup or edit, use the Agent tool or direct tools instead.\n\n' +

    '## Primitives\n\n' +
    '- agent(prompt: string, opts?: {label?, phase?, schema?, model?, effort?, isolation?}): Promise<any> — spawn a subagent. ' +
    'Without schema, returns final text as string. With schema (JSON Schema), returns validated object — retries on mismatch.\n' +
    '- parallel(thunks: Array<() => Promise<any>>): Promise<any[]> — BARRIER: runs all thunks concurrently, waits for all. ' +
    'Failed thunks resolve to null. Use filter(Boolean) before consuming results.\n' +
    '- pipeline(items: T[], ...stages): Promise<any[]> — NO barrier: each item flows through all stages independently. ' +
    'Item A can be in stage 3 while item B is still in stage 1. DEFAULT choice for multi-stage work.\n' +
    '- verify(finding, opts): Promise<VerifyResult> — adversarial/perspective/consensus quality gate. ' +
    'Spawns skeptics or lens-based judges, applies threshold, returns {survives, votes, score}.\n' +
    '- judge(attempts, opts): Promise<JudgeResult> — judge panel: N attempts scored by M judges across K criteria. ' +
    'Returns winner with optional synthesis grafting runner-up ideas.\n' +
    '- loopUntilConvergence(opts): Promise<LoopUntilConvergenceResult> — convergent discovery loop. ' +
    'Fans out finders repeatedly, deduplicates against seen-set (NOT confirmed-set), ' +
    'stops after N consecutive dry rounds or maxRounds. Optionally verifies each finding.\n' +
    '- phase(title: string): void — start a new progress group\n' +
    '- log(message: string): void — emit progress message\n' +
    '- args: any — verbatim args passed to Workflow tool\n' +
    '- budget: {total, spent(), remaining()} — token budget tracking\n\n' +

    '## Topology Selection Guide\n\n' +
    'DEFAULT TO pipeline(). Only reach for a barrier (parallel between stages) when you genuinely ' +
    'need ALL prior-stage results together.\n\n' +
    'A barrier is correct ONLY when stage N needs cross-item context from all of stage N-1: ' +
    'dedup/merge across the full result set, early-exit if total count is zero, cross-finding comparison.\n\n' +
    'A barrier is NOT justified by: flatten/map/filter (do it inside a pipeline stage), ' +
    'conceptually separate stages, cleaner code — barrier latency is real and measurable.\n\n' +
    '- Diamond (fan-out → reduce → synthesize): market scans, audits, research\n' +
    '- Pipeline (no barrier): each item flows independently — DEFAULT\n' +
    '- Loop-until-convergence: unknown-size discovery (bugs, vulnerabilities, edge cases)\n' +
    '- Judge panel: multiple competing approaches, pick best + graft runner-ups\n' +
    '- Verifier-on-edge: quality gates before results reach downstream\n\n' +

    '## Critical Rules\n\n' +
    '- EDGE LOGIC IS FREE: flatten, dedupe, filter in plain JavaScript — NOT agent calls. ' +
    'results.flatMap(...) and a Set are deterministic, instant, zero tokens.\n' +
    '- seen-set dedup for loops, NOT confirmed-set — rejected findings would otherwise revive every round.\n' +
    '- Each node should have bounded input, validated output (schema), and one clear purpose.\n' +
    '- Model tiering: use cheaper models for repetitive extraction/classification nodes, ' +
    'expensive models for synthesis/judgment nodes.\n\n' +

    '## Script Format\n\n' +
    'Every script MUST begin with: export const meta = { name, description, phases: [{title, detail}] }\n' +
    'The meta object must be a PURE LITERAL — no variables, function calls, or template interpolation.\n' +
    'Use the SAME phase titles in meta.phases as in phase() calls.',
```

- [ ] **Step 2: Run typecheck to verify no syntax errors in the string**

```bash
cd apps/cli && pnpm typecheck
```
Expected: zero errors (the description is just a string)

- [ ] **Step 3: Run full test suite**

```bash
cd apps/cli && pnpm test
```
Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/tools/agent/workflow.ts
git commit -m "feat: expand Workflow tool description into graph engineering guide (Step 14)"
```

---

### Task 3.2: Enhance /workflow slash commands

**Files:**
- Modify: `apps/cli/src/ui/commands.ts`

**Interfaces:**
- Consumes: existing `workflowsCmd` (listing), command registry
- Produces: `/workflow <task>`, `/workflow save <name>`, `/workflow run <name>`

- [ ] **Step 1: Add `/workflow <task>` — auto-generate and run**

Find the command registry section (around line 4321 where `/workflows` is registered). Add a new handler that constructs a prompt telling the AI to write and execute a workflow:

```typescript
// ── /workflow <task description> — auto-generate + execute ──

const workflowAutoCmd: CommandHandler = async (args, context) => {
  if (!args || args.trim() === '') {
    return {
      content:
        'Usage: /workflow <task description>\n\n' +
        'Describes the task, and the AI will generate a workflow script to execute it.\n' +
        'Examples:\n' +
        '  /workflow audit all routes for missing auth\n' +
        '  /workflow research the impact of React 19 on our codebase\n' +
        '  /workflow find all hardcoded credentials in the codebase\n\n' +
        'Sub-commands:\n' +
        '  /workflow save <name>  — save last successful workflow script\n' +
        '  /workflow run <name>    — run a saved workflow by name\n' +
        '  /workflows              — list all saved workflow scripts',
    }
  }

  // Sub-commands
  const parts = args.trim().split(/\s+/)
  if (parts[0] === 'save' && parts[1]) {
    return workflowSaveCmd(parts.slice(1).join(' '), context)
  }
  if (parts[0] === 'run' && parts[1]) {
    return workflowRunCmd(parts.slice(1).join(' '), context)
  }

  // Default: forward to AI to generate + execute workflow
  return {
    forwardToAI:
      `Write and execute a workflow script for this task: ${args}\n\n` +
      `Use the Workflow tool to execute the generated script. ` +
      `After the workflow completes, summarize the results and offer to save the script ` +
      `with /workflow save <name> if it is reusable.`,
  }
}
```

- [ ] **Step 2: Add `/workflow save <name>` handler**

```typescript
const workflowSaveCmd = async (name: string, _context: unknown) => {
  const { existsSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const locations = [
    join(process.cwd(), '.claude', 'workflows'),
    join(process.env.HOME || '~', '.claude', 'workflows'),
  ]

  // Save to project-level by default
  const targetDir = locations[0]!
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  // The AI sets this via context after a successful run
  // We read from a temporary state file
  const stateFile = join(targetDir, '.last-run.json')
  if (!existsSync(stateFile)) {
    return { content: 'No recent workflow run found. Run a workflow first with /workflow <task>.' }
  }

  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf-8'))
    const script = state.script as string
    if (!script) {
      return { content: 'No script found in last run state.' }
    }

    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-')
    const scriptPath = join(targetDir, `${safeName}.js`)
    writeFileSync(scriptPath, script, 'utf-8')

    return { content: `Workflow saved to ${scriptPath}\nUse /workflow run ${safeName} to run it again.` }
  } catch (err) {
    return { content: `Failed to save workflow: ${String(err)}` }
  }
}
```

- [ ] **Step 3: Add `/workflow run <name>` handler**

```typescript
const workflowRunCmd = async (name: string, _context: unknown) => {
  const { existsSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-')

  const locations = [
    join(process.cwd(), '.claude', 'workflows'),
    join(process.env.HOME || '~', '.claude', 'workflows'),
  ]

  for (const loc of locations) {
    const scriptPath = join(loc, `${safeName}.js`)
    if (existsSync(scriptPath)) {
      return {
        forwardToAI:
          `Read the workflow script at ${scriptPath}, then call the Workflow tool with ` +
          `scriptPath: "${scriptPath}" to execute it. Report the results.`,
      }
    }
  }

  return { content: `Workflow "${safeName}" not found in .claude/workflows/ or ~/.claude/workflows/` }
}
```

- [ ] **Step 4: Register the new commands**

Find the existing `/workflows` registration and update to include the new commands:

```typescript
// Replace the existing registry.set('/workflows', workflowsCmd) with:
registry.set('/workflow', workflowAutoCmd)
registry.set('/workflows', workflowsCmd)  // keep existing listing command
```

- [ ] **Step 5: Update the last-run state after successful workflow execution**

In `apps/cli/src/tools/agent/workflow.ts`, after a successful `runWorkflow()` call, persist the script:

Add this after the `runWorkflow` call succeeds (around line 55-70):
```typescript
// Persist last-run state for /workflow save
try {
  const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const workflowsDir = join(process.cwd(), '.claude', 'workflows')
  if (!existsSync(workflowsDir)) {
    mkdirSync(workflowsDir, { recursive: true })
  }
  writeFileSync(
    join(workflowsDir, '.last-run.json'),
    JSON.stringify({ runId, script, timestamp: new Date().toISOString() }),
    'utf-8',
  )
} catch {
  // best-effort — don't fail the workflow if state persistence fails
}
```

- [ ] **Step 6: Run typecheck**

```bash
cd apps/cli && pnpm typecheck
```
Expected: zero errors

- [ ] **Step 7: Run tests**

```bash
cd apps/cli && pnpm test
```
Expected: all tests PASS

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/ui/commands.ts apps/cli/src/tools/agent/workflow.ts
git commit -m "feat: add /workflow <task>, /workflow save, /workflow run commands"
```

---

### Task 3.3: Inject workflow auto-generation system instruction

**Files:**
- Modify: `apps/cli/src/core/instructions.ts`

**Interfaces:**
- Consumes: `buildSystemPrompt()` method
- Produces: Workflow auto-generation rule appended to system prompt

- [ ] **Step 1: Add the instruction to `buildSystemPrompt()`**

In `apps/cli/src/core/instructions.ts`, find the `buildSystemPrompt()` method (around line 50). After the `parts.push(...)` for skillsReminder, add:

```typescript
    // Inject workflow auto-generation guidance
    parts.push(`## Workflow Auto-Generation

When a task involves 3+ independent subtasks, multi-file operations,
or unknown-size discovery, generate a workflow script and execute it
via the Workflow tool instead of running agents sequentially. The
orchestration itself is code (zero tokens for inter-agent coordination).

Prefer workflows for: audits across many files, web research with multiple
sources, code migrations touching many files, security scans, bug hunts
with unknown scope, multi-dimensional code reviews.

Available primitives: agent(), parallel(), pipeline(), verify(),
judge(), loopUntilConvergence(), phase(), log(), args, budget.

Key rules:
- Default to pipeline() — only use parallel() barrier when a stage
  genuinely needs all prior results at once
- Edge logic (flatten, dedupe, filter) is plain JS — not agent calls
- Use verify() on edges where confidence matters
- Use loopUntilConvergence() for discovery tasks with unknown size

When a workflow completes successfully, offer to save it:
"Workflow complete. Save this script? /workflow save <name>"

Script format: export const meta = { name, description, phases: [...] }
// script body using primitives...`)
```

- [ ] **Step 2: Run typecheck + tests**

```bash
cd apps/cli && pnpm typecheck && pnpm test
```
Expected: zero errors, all tests PASS

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/core/instructions.ts
git commit -m "feat: inject workflow auto-generation system instruction (Step 14)"
```

---

### Task 3.4: Create workflow template scripts

**Files:**
- Create: `apps/cli/skills/workflows/audit.js`
- Create: `apps/cli/skills/workflows/research.js`
- Create: `apps/cli/skills/workflows/migrate.js`
- Create: `apps/cli/skills/workflows/review.js`
- Create: `apps/cli/skills/workflows/hunt.js`
- Create: `apps/cli/skills/workflows/judge.js`

**Interfaces:**
- Each produces: A standalone workflow script with `export const meta` header
- Each is directly executable via `/workflow run <name>` or the Workflow tool with `scriptPath`

- [ ] **Step 1: Create skills/workflows/ directory and audit.js**

```bash
mkdir -p apps/cli/skills/workflows
```

Create `apps/cli/skills/workflows/audit.js`:
```javascript
export const meta = {
  name: 'audit',
  description: 'Security audit: fan-out per file → verify → report',
  phases: [
    { title: 'Scope', detail: 'discover targets' },
    { title: 'Audit', detail: 'one agent per target' },
    { title: 'Verify', detail: 'adversarial verification' },
    { title: 'Report', detail: 'synthesize findings' },
  ],
}

phase('Scope')
const targets = args.targets || (await agent(
  'List all source files that need security auditing. Return { files: [{ path, reason }] }',
  { schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'reason'] } } }, required: ['files'] } },
)).files

log(`Auditing ${targets.length} files`)

phase('Audit')
const findings = (await pipeline(
  targets,
  t => agent(`Security audit ${t.path}: injection, auth, crypto, secrets, input validation. Return { findings: [{ severity, file, line, summary }] }`,
    { label: `audit:${t.path}`, schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' } }, required: ['severity', 'file', 'summary'] } } }, required: ['findings'] } },
  )),
)).flatMap(r => r?.findings || [])

log(`Found ${findings.length} potential issues`)

phase('Verify')
const verified = await parallel(
  findings.map(f => () =>
    verify(f, {
      mode: 'adversarial',
      skeptics: 3,
      threshold: 2,
      schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] },
    })
  ),
)

const confirmed = verified.filter(Boolean).filter(v => v.survives).map(v => v.finding)
log(`${confirmed.length}/${findings.length} findings verified`)

phase('Report')
const report = await agent(
  `Synthesize audit report from confirmed findings:\n${JSON.stringify(confirmed)}`,
  { label: 'report' },
)
return report
```

- [ ] **Step 2: Create research.js**

```javascript
export const meta = {
  name: 'research',
  description: 'Deep research: scope → parallel search → verify → synthesize',
  phases: [
    { title: 'Scope', detail: 'define research angles' },
    { title: 'Research', detail: 'parallel web searches' },
    { title: 'Verify', detail: 'adversarial verification' },
    { title: 'Synthesize', detail: 'final report' },
  ],
}

phase('Scope')
const topic = args.topic || (await agent('What topic should we research?', { label: 'query' }))

phase('Research')
const angles = ['overview', 'technical-details', 'competitors', 'criticism', 'future-trends']
const raw = await parallel(
  angles.map(angle => () =>
    agent(`Research "${topic}" from angle: ${angle}. Return { sources: [{ title, url, keyPoint }] }`,
      { label: `research:${angle}`, schema: { type: 'object', properties: { sources: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' }, keyPoint: { type: 'string' } }, required: ['title', 'keyPoint'] } } }, required: ['sources'] } },
    )),
)

const allSources = raw.filter(Boolean).flatMap(r => r.sources)
const seen = new Set()
const unique = allSources.filter(s => { const k = s.url; if (seen.has(k)) return false; seen.add(k); return true })
log(`Collected ${unique.length} unique sources`)

phase('Verify')
const verified = await parallel(
  unique.map(s => () =>
    verify({ claim: s.keyPoint, source: s.title }, {
      mode: 'adversarial',
      skeptics: 2,
      threshold: 1,
      schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] },
    }),
  ),
)

const credible = verified.filter(Boolean).filter(v => v.survives).map(v => v.finding)

phase('Synthesize')
const report = await agent(
  `Synthesize research report on "${topic}" from credible sources:\n${JSON.stringify(credible)}`,
  { label: 'synthesize' },
)
return report
```

- [ ] **Step 3: Create migrate.js**

```javascript
export const meta = {
  name: 'migrate',
  description: 'Code migration: discover → fan-out transform → verify → integrate',
  phases: [
    { title: 'Discover', detail: 'find migration targets' },
    { title: 'Transform', detail: 'one agent per file' },
    { title: 'Verify', detail: 'validate transformations' },
  ],
}

phase('Discover')
const pattern = args.pattern || (await agent('What code pattern needs migration? Return { pattern, replacement, reason }',
  { schema: { type: 'object', properties: { pattern: { type: 'string' }, replacement: { type: 'string' }, reason: { type: 'string' } }, required: ['pattern', 'replacement'] } },
))

const files = await agent(
  `Find all files matching pattern: ${pattern.pattern}. Return { files: [{ path }] }`,
  { schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }, required: ['files'] } },
)

log(`Migrating ${files.files.length} files: ${pattern.pattern} → ${pattern.replacement}`)

phase('Transform')
const results = await pipeline(
  files.files,
  f => agent(
    `In ${f.path}, migrate "${pattern.pattern}" to "${pattern.replacement}". Reason: ${pattern.reason}. Return { path, changes, success }`,
    { label: `migrate:${f.path}`, isolation: 'worktree', schema: { type: 'object', properties: { path: { type: 'string' }, changes: { type: 'number' }, success: { type: 'boolean' } }, required: ['path', 'success'] } },
  ),
)

const succeeded = results.filter(Boolean).filter(r => r.success)
const failed = results.filter(Boolean).filter(r => !r.success)
log(`${succeeded.length} migrated, ${failed.length} failed`)

phase('Verify')
const verified = await parallel(
  succeeded.map(f => () =>
    verify({ file: f.path, migration: pattern.replacement }, {
      mode: 'perspective',
      lenses: ['correctness', 'style'],
      threshold: 1,
      schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] },
    }),
  ),
)

return { migrated: succeeded.length, failed: failed.length, verified: verified.filter(Boolean).filter(v => v.survives).length }
```

- [ ] **Step 4: Create review.js**

```javascript
export const meta = {
  name: 'review',
  description: 'Code review: fan-out per dimension → judge panel → report',
  phases: [
    { title: 'Review', detail: 'multi-dimensional review' },
    { title: 'Judge', detail: 'judge panel scores findings' },
    { title: 'Report', detail: 'final review report' },
  ],
}

phase('Review')
const dimensions = ['correctness', 'security', 'performance', 'maintainability']
const rawFindings = await parallel(
  dimensions.map(d => () =>
    agent(`Review the code from the "${d}" lens. Return { findings: [{ severity, file, line, summary }] }`,
      { label: `review:${d}`, schema: { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low'] }, file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, dimension: { type: 'string' } }, required: ['severity', 'file', 'summary'] } } }, required: ['findings'] } },
    )),
)

// Edge logic: dedup across dimensions (pure JS)
const allFindings = rawFindings.filter(Boolean).flatMap(r => r.findings)
const seen = new Set()
const uniqueFindings = allFindings.filter(f => {
  const k = `${f.file}:${f.line}:${f.summary}`
  if (seen.has(k)) return false; seen.add(k); return true
})

log(`${uniqueFindings.length} unique findings across ${dimensions.length} dimensions`)

phase('Judge')
if (uniqueFindings.length === 0) {
  return 'No findings — code looks clean across all dimensions.'
}

// Judge panel: rank findings by severity
const judged = await judge(
  uniqueFindings.map(f => ({ finding: f })),
  {
    criteria: ['severity', 'actionability', 'confidence'],
    judges: 2,
    synthesize: false,
    schema: {
      type: 'object',
      properties: {
        scores: { type: 'object', properties: { severity: { type: 'number' }, actionability: { type: 'number' }, confidence: { type: 'number' } }, required: ['severity', 'actionability', 'confidence'] },
        notes: { type: 'string' },
      },
      required: ['scores', 'notes'],
    },
  },
)

phase('Report')
return await agent(
  `Write a code review report from ${uniqueFindings.length} findings (ranked by judge panel). Top finding: ${JSON.stringify(judged.winner)}`,
  { label: 'report' },
)
```

- [ ] **Step 5: Create hunt.js**

```javascript
export const meta = {
  name: 'hunt',
  description: 'Bug hunt: loopUntilConvergence + adversarial verify',
  phases: [
    { title: 'Hunt', detail: 'iterative discovery + verify' },
    { title: 'Report', detail: 'synthesize findings' },
  ],
}

phase('Hunt')
const target = args.target || 'this codebase'

const { confirmed, totalSeen, rounds, converged } = await loopUntilConvergence({
  finders: [
    () => agent(`Find bugs in ${target}. Look for: null safety, race conditions, resource leaks, edge cases. Return { items: [{ file, line, summary, type }] }`,
      { label: 'hunt:general', schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, type: { type: 'string' } }, required: ['file', 'summary', 'type'] } } }, required: ['items'] } },
    ),
    () => agent(`Find security vulnerabilities in ${target}: injection, auth bypass, insecure crypto, exposed secrets. Return { items: [{ file, line, summary, type }] }`,
      { label: 'hunt:security', schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, type: { type: 'string' } }, required: ['file', 'summary', 'type'] } } }, required: ['items'] } },
    ),
  ],
  keyFn: (bug) => `${bug.file}:${bug.line}:${bug.summary}`,
  verify: async (bug) => verify(bug, {
    mode: 'adversarial',
    skeptics: 3,
    threshold: 2,
    schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] },
  }),
  dryRounds: 2,
  maxRounds: 10,
})

log(`${converged ? 'Converged' : 'Max rounds reached'} after ${rounds} rounds. ${totalSeen} unique bugs seen, ${confirmed.length} confirmed.`)

phase('Report')
if (confirmed.length === 0) {
  return `No confirmed bugs found after ${rounds} rounds of hunting.`
}
return await agent(
  `Write a bug report from ${confirmed.length} confirmed bugs:\n${JSON.stringify(confirmed)}`,
  { label: 'report' },
)
```

- [ ] **Step 6: Create judge.js**

```javascript
export const meta = {
  name: 'judge',
  description: 'Judge panel: N competing approaches × M judges → winner + synthesis',
  phases: [
    { title: 'Generate', detail: 'generate competing approaches' },
    { title: 'Judge', detail: 'score and rank' },
    { title: 'Synthesize', detail: 'final recommendation' },
  ],
}

phase('Generate')
const problem = args.problem || (await agent('What problem are we solving?', { label: 'query' }))

const approaches = await parallel([
  () => agent(`Solve "${problem}" with an MVP-first approach.`, { label: 'gen:mvp' }),
  () => agent(`Solve "${problem}" with a risk-first approach.`, { label: 'gen:risk' }),
  () => agent(`Solve "${problem}" with a user-first approach.`, { label: 'gen:user' }),
])

const validApproaches = approaches.filter(Boolean)
log(`Generated ${validApproaches.length} approaches`)

phase('Judge')
const { winner, winnerIndex, scores, synthesis } = await judge(
  validApproaches,
  {
    criteria: ['feasibility', 'impact', 'simplicity', 'risk'],
    judges: 3,
    synthesize: true,
    schema: {
      type: 'object',
      properties: {
        scores: { type: 'object', properties: { feasibility: { type: 'number' }, impact: { type: 'number' }, simplicity: { type: 'number' }, risk: { type: 'number' } }, required: ['feasibility', 'impact', 'simplicity', 'risk'] },
        notes: { type: 'string' },
      },
      required: ['scores', 'notes'],
    },
  },
)

phase('Synthesize')
return {
  problem,
  winner: `Approach #${winnerIndex + 1}`,
  scores_summary: scores.map(s => `Judge ${s.judgeIndex + 1}: approach ${s.attemptIndex + 1} = ${s.total}`),
  synthesis,
}
```

- [ ] **Step 7: Commit all templates**

```bash
git add apps/cli/skills/workflows/
git commit -m "feat: add 6 workflow templates (audit, research, migrate, review, hunt, judge)"
```

---

### Task 3.5: Final integration verification

- [ ] **Step 1: Run full test suite**

```bash
cd apps/cli && pnpm test
```
Expected: ALL tests PASS

- [ ] **Step 2: Run typecheck**

```bash
cd apps/cli && pnpm typecheck
```
Expected: zero errors

- [ ] **Step 3: Run lint + format**

```bash
cd apps/cli && pnpm lint && pnpm format
```
Expected: zero lint errors, all files formatted

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: final integration — graph engineering Steps 09/11/14 complete"
```

---

## Plan Self-Review

### 1. Spec Coverage

| Spec requirement | Task |
|-----------------|------|
| verify() adversarial/perspective/consensus | Task 1.2 |
| judge() judge panel + synthesis | Task 1.2 |
| verify + judge tests (8 cases) | Task 1.1 |
| loopUntilConvergence() seen-set dedup | Task 2.2 |
| loopUntilConvergence tests (6 cases) | Task 2.1 |
| Runtime injection (verify/judge/loopUntilConvergence) | Tasks 1.3, 2.3 |
| Workflow tool description expansion | Task 3.1 |
| /workflow <task> command | Task 3.2 |
| /workflow save <name> | Task 3.2 |
| /workflow run <name> | Task 3.2 |
| System instruction injection | Task 3.3 |
| 6 template workflow scripts | Task 3.4 |

**Coverage assessment:** All spec requirements have corresponding tasks. ✅

### 2. Placeholder Scan

- No TBD/TODO/incomplete sections ✅
- No "add appropriate error handling" without actual code ✅
- No "similar to Task N" references ✅
- All types referenced in later tasks are defined in earlier tasks ✅
- All file paths are exact ✅

### 3. Type Consistency

- `VerifyResult` defined in Task 1.2, consumed in Task 2.2 ✅
- `JudgeResult` defined in Task 1.2, consumed in Task 3.4 ✅
- `LoopUntilConvergenceResult<T>` defined in Task 2.2, consumed in Task 3.4 ✅
- `verify()` signature consistent across Tasks 1.2, 1.3, 2.1, 2.2, 3.4 ✅
- `judge()` signature consistent across Tasks 1.2, 1.3, 3.4 ✅
- `loopUntilConvergence()` signature consistent across Tasks 2.2, 2.3, 3.4 ✅

