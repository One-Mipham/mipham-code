import { describe, it, expect } from 'vitest'
import { parallel } from '../../src/workflow/primitives/parallel'

describe('parallel', () => {
  it('runs all thunks and returns results in input order', async () => {
    const results = await parallel([1, 2, 3, 4, 5].map((n) => async () => n * 2))
    expect(results).toEqual([2, 4, 6, 8, 10])
  })

  it('resolves failed thunks to null without rejecting the barrier', async () => {
    const results = await parallel([
      async () => 'ok',
      async () => {
        throw new Error('boom')
      },
      async () => 'also ok',
    ])
    expect(results[0]).toBe('ok')
    expect(results[1]).toBeNull()
    expect(results[2]).toBe('also ok')
  })

  it('returns an empty array for no thunks', async () => {
    expect(await parallel([])).toEqual([])
  })
})
