import { describe, it, expect } from 'vitest'
import { Context } from '../../src/vajra/context'
import type { Service } from '../../src/vajra/service'
import type { Constitution } from '../../src/vajra/constitution'
import { CONSTITUTION_KEY } from '../../src/vajra/constitution'

/** 测试替身：只放行 `known` 中列出的原则 id。 */
const allowOnly = (...known: string[]): Constitution => ({
  check: (aligned) => ({ violations: aligned.filter((id) => !known.includes(id)) }),
})

describe('Context.mount alignment seam', () => {
  it('mounts a service whose declared alignment is satisfied', () => {
    const ctx = new Context()
    ctx.provide(CONSTITUTION_KEY, allowOnly('never-fabricate', 'respect-permissions'))
    const svc: Service = {
      align: ['never-fabricate'],
      apply() {},
    }
    const m = ctx.mount(svc)
    expect(m.status()).toBe('active')
  })

  it('refuses to mount a service declaring an unknown principle', () => {
    const ctx = new Context()
    ctx.provide(CONSTITUTION_KEY, allowOnly('never-fabricate'))
    let applied = false
    const svc: Service = {
      align: ['never-fabricate', 'not-a-real-principle'],
      apply() {
        applied = true
      },
    }
    const m = ctx.mount(svc)
    expect(m.status()).toBe('failed')
    expect(m.error?.message).toContain('not-a-real-principle')
    expect(applied).toBe(false)
  })

  it('mounts services without align (backward compatible)', () => {
    const ctx = new Context()
    ctx.provide(CONSTITUTION_KEY, allowOnly())
    let applied = false
    const svc: Service = {
      apply() {
        applied = true
      },
    }
    const m = ctx.mount(svc)
    expect(m.status()).toBe('active')
    expect(applied).toBe(true)
  })

  it('does not gate when no constitution is provided (opt-in)', () => {
    const ctx = new Context()
    let applied = false
    const svc: Service = {
      align: ['anything'],
      apply() {
        applied = true
      },
    }
    const m = ctx.mount(svc)
    expect(m.status()).toBe('active')
    expect(applied).toBe(true)
  })

  it('defers the alignment check until dependencies are satisfied', () => {
    const ctx = new Context()
    ctx.provide(CONSTITUTION_KEY, allowOnly('never-fabricate'))
    let applied = false
    const svc: Service = {
      inject: ['cfg'],
      align: ['not-a-real-principle'],
      apply() {
        applied = true
      },
    }
    const m = ctx.mount(svc)
    expect(m.status()).toBe('inactive') // deps missing → not yet applied/checked
    ctx.provide('cfg', {})
    expect(m.status()).toBe('failed') // deps now present → alignment check rejects
    expect(applied).toBe(false)
  })
})
