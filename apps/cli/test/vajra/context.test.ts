import { describe, it, expect } from 'vitest'
import { Context } from '../../src/vajra/context'

describe('Context service repository', () => {
  it('provides and gets a service by key', () => {
    const ctx = new Context()
    ctx.provide('llm', { name: 'deepseek' })
    expect(ctx.get('llm')).toEqual({ name: 'deepseek' })
    expect(ctx.get('missing')).toBeUndefined()
  })

  it('provide returns a disposer that removes the service', () => {
    const ctx = new Context()
    const off = ctx.provide('tmp', 1)
    expect(ctx.has('tmp')).toBe(true)
    off()
    expect(ctx.has('tmp')).toBe(false)
  })

  it('scope() creates a child that falls back to parent and can shadow', () => {
    const root = new Context()
    root.provide('cfg', { x: 1 })
    const child = root.scope('agent-1')
    expect(child.get('cfg')).toEqual({ x: 1 })
    child.provide('cfg', { x: 2 })
    expect(child.get('cfg')).toEqual({ x: 2 })
    expect(root.get('cfg')).toEqual({ x: 1 })
  })

  it('has() checks local then parent', () => {
    const root = new Context()
    root.provide('a', 1)
    const child = root.scope('agent-1')
    expect(child.has('a')).toBe(true)
    expect(child.has('b')).toBe(false)
  })
})

describe('Context reversible effects', () => {
  it('effect registers and returns a disposer', () => {
    const ctx = new Context()
    const log: string[] = []
    const off = ctx.effect(() => {
      log.push('setup')
      return () => log.push('teardown')
    })
    expect(log).toEqual(['setup'])
    off()
    expect(log).toEqual(['setup', 'teardown'])
  })

  it('dispose() unwinds effects in LIFO order', () => {
    const ctx = new Context()
    const log: string[] = []
    ctx.effect(() => {
      log.push('a+')
      return () => log.push('a-')
    })
    ctx.effect(() => {
      log.push('b+')
      return () => log.push('b-')
    })
    ctx.dispose()
    expect(log).toEqual(['a+', 'b+', 'b-', 'a-'])
  })

  it('effect without a returned disposer is safe to dispose', () => {
    const ctx = new Context()
    const log: string[] = []
    ctx.effect(() => {
      log.push('x')
    })
    ctx.dispose()
    expect(log).toEqual(['x'])
  })

  it('manual dispose then context dispose does not double-teardown', () => {
    const ctx = new Context()
    let count = 0
    const off = ctx.effect(() => () => {
      count++
    })
    off()
    ctx.dispose()
    expect(count).toBe(1)
  })

  it('dispose() unwinds remaining effects when a disposer throws', () => {
    const ctx = new Context()
    const log: string[] = []
    ctx.effect(() => {
      log.push('a+')
      return () => log.push('a-')
    })
    ctx.effect(() => {
      log.push('b+')
      return () => {
        throw new Error('teardown boom')
      }
    })
    expect(() => ctx.dispose()).toThrow(AggregateError)
    expect(log).toEqual(['a+', 'b+', 'a-'])
  })
})
