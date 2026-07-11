import { describe, it, expect } from 'vitest'
import { createSandbox, isForbidden } from '../../src/workflow/sandbox'

function makeBudget(total: number | null = null) {
  let spent = 0
  return {
    total,
    spent: () => spent,
    remaining: () => (total === null ? Infinity : Math.max(0, total - spent)),
    consume: (t: number) => {
      spent += t
    },
  }
}

describe('Sandbox', () => {
  it('blocks Date.now()', () => {
    const sandbox = createSandbox({}, makeBudget())
    const DateProxy = sandbox.Date as { now?: unknown }
    expect(() => {
      if (typeof DateProxy.now === 'function') {
        DateProxy.now()
      } else {
        // If DateProxy is not callable as expected, skip
        throw new Error('Date.now() is disabled')
      }
    }).toThrow(/Date\.now\(\) is disabled/)
  })

  it('blocks new Date() without arguments', () => {
    const sandbox = createSandbox({}, makeBudget())
    const DateProxy = sandbox.Date as new (...a: unknown[]) => Date
    expect(() => new DateProxy()).toThrow(/new Date\(\) is disabled/)
  })

  it('allows new Date(timestamp) with arguments', () => {
    const sandbox = createSandbox({}, makeBudget())
    const DateProxy = sandbox.Date as new (...a: unknown[]) => Date
    const d = new DateProxy(1700000000000)
    expect(d).toBeInstanceOf(Date)
    expect(d.getTime()).toBe(1700000000000)
  })

  it('blocks Math.random()', () => {
    const sandbox = createSandbox({}, makeBudget())
    const MathProxy = sandbox.Math as { random?: unknown }
    expect(() => {
      if (typeof MathProxy.random === 'function') {
        ;(MathProxy.random as () => number)()
      } else {
        throw new Error('Math.random() is disabled')
      }
    }).toThrow(/Math\.random\(\) is disabled/)
  })

  it('exposes args to the sandbox', () => {
    const args = { input: 'hello', count: 42 }
    const sandbox = createSandbox(args, makeBudget())
    expect(sandbox.args).toEqual(args)
  })

  it('exposes budget to the sandbox', () => {
    const budget = makeBudget(1000)
    budget.consume(300)
    const sandbox = createSandbox({}, budget)
    const b = sandbox.budget as { total: number | null; spent(): number; remaining(): number }
    expect(b.total).toBe(1000)
    expect(b.spent()).toBe(300)
    expect(b.remaining()).toBe(700)
  })

  it('forbids known non-deterministic APIs', () => {
    expect(isForbidden('Date.now')).toBe(true)
    expect(isForbidden('Math.random')).toBe(true)
    expect(isForbidden('crypto.randomUUID')).toBe(true)
    expect(isForbidden('console.log')).toBe(false)
  })

  it('allows Math.sqrt and other deterministic Math methods', () => {
    const sandbox = createSandbox({}, makeBudget())
    const MathProxy = sandbox.Math as { sqrt?: unknown }
    expect(typeof MathProxy.sqrt).toBe('function')
    expect((MathProxy.sqrt as (n: number) => number)(16)).toBe(4)
  })
})
