import { describe, it, expect } from 'vitest'
import { nextBackoff } from '../../src/daemon/backoff.js'

describe('nextBackoff', () => {
  it('指数退避', () => expect(nextBackoff(1000)).toBe(2000))
  it('封顶 30s', () => expect(nextBackoff(20000)).toBe(30000))
})
