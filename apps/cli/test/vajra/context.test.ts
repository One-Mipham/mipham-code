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
