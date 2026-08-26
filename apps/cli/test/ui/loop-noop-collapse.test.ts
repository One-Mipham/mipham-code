import { describe, it, expect } from 'vitest'
import { collapseNoopTicks } from '../../src/ui/loop-noop'

describe('collapseNoopTicks', () => {
  it('collapses consecutive noop ticks into one line', () => {
    const ticks = [{ noop: true }, { noop: true }, { noop: false }, { noop: true }]
    expect(collapseNoopTicks(ticks)).toBe('💤 idle ×2\n● active\n💤 idle ×1')
  })
})
