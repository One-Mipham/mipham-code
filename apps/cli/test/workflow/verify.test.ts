import { describe, it, expect, vi } from 'vitest'

// We test verify() and judge() as pure functions by mocking the agent primitive.
// The real agent is tested in integration via runtime.test.ts.
// Here we inject a mock agent that returns pre-baked responses.

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
      { mode: 'consensus', voters: 3, schema: { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real', 'reason'] }, _mockAgent: twoReal },
    )
    expect(r2.survives).toBe(false)
  })
})

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
