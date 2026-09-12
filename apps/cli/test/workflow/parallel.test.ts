import { describe, it, expect } from 'vitest'
import { parallel, resolveMaxConcurrent } from '../../src/workflow/primitives/parallel'

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

describe('resolveMaxConcurrent', () => {
  it('returns the CPU-derived cap (1–16) when unset', () => {
    const n = resolveMaxConcurrent(undefined)
    expect(n).toBeGreaterThanOrEqual(1)
    expect(n).toBeLessThanOrEqual(16)
  })

  it('honours an explicit 1–256 value', () => {
    expect(resolveMaxConcurrent('1')).toBe(1)
    expect(resolveMaxConcurrent('32')).toBe(32)
    expect(resolveMaxConcurrent('256')).toBe(256)
  })

  it('clamps values above 256', () => {
    expect(resolveMaxConcurrent('999')).toBe(256)
  })

  it('falls back to the default for empty, non-numeric, zero, and negative values', () => {
    expect(resolveMaxConcurrent('')).toBeGreaterThanOrEqual(1)
    expect(resolveMaxConcurrent('abc')).toBeGreaterThanOrEqual(1)
    expect(resolveMaxConcurrent('0')).toBeGreaterThanOrEqual(1)
    expect(resolveMaxConcurrent('-5')).toBeGreaterThanOrEqual(1)
  })
})
