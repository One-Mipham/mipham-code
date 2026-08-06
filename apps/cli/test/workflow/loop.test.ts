import { describe, it, expect, vi } from 'vitest'

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
    const mockVerify = vi.fn(async (item: any) => ({
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
    expect(result.confirmed).toHaveLength(0) // nothing survived verify
    expect(result.totalSeen).toBe(1) // x was seen once
    expect(result.rounds).toBe(3) // converged, not infinite
    expect(result.converged).toBe(true)
    expect(mockVerify).toHaveBeenCalledTimes(1) // only called once, not every round
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

    const mockVerify = vi.fn(async (item: any) => {
      const obj = item as { id: string }
      return {
        finding: item,
        survives: obj.id === 'real-bug',
        votes: [
          { real: obj.id === 'real-bug', reason: obj.id === 'real-bug' ? 'confirmed' : 'refuted' },
        ],
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
