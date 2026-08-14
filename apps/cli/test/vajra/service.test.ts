import { describe, it, expect } from 'vitest'
import { Context } from '../../src/vajra/context'
import type { Service } from '../../src/vajra/service'

describe('Context.mount lifecycle', () => {
  it('mount applies immediately when dependencies are present', () => {
    const ctx = new Context()
    ctx.provide('cfg', { x: 1 })
    let applied = false
    const svc: Service = {
      inject: ['cfg'],
      apply(c) {
        applied = true
        expect(c.get('cfg')).toEqual({ x: 1 })
      },
    }
    const m = ctx.mount(svc)
    expect(applied).toBe(true)
    expect(m.status()).toBe('active')
  })

  it('mount defers when deps missing, activates on provide', () => {
    const ctx = new Context()
    let applied = false
    const svc: Service = {
      inject: ['cfg'],
      apply() {
        applied = true
      },
    }
    const m = ctx.mount(svc)
    expect(applied).toBe(false)
    expect(m.status()).toBe('inactive')
    ctx.provide('cfg', { x: 1 })
    expect(applied).toBe(true)
    expect(m.status()).toBe('active')
  })

  it('mount isolates apply failure — host survives, status failed', () => {
    const ctx = new Context()
    const svc: Service = {
      apply() {
        throw new Error('boom')
      },
    }
    const m = ctx.mount(svc)
    expect(m.status()).toBe('failed')
    expect(m.error?.message).toBe('boom')
    // host still usable
    ctx.provide('ok', 1)
    expect(ctx.get('ok')).toBe(1)
  })

  it('mount.dispose() unwinds the service effects', () => {
    const ctx = new Context()
    const log: string[] = []
    const svc: Service = {
      apply(c) {
        return c.effect(() => {
          log.push('up')
          return () => log.push('down')
        })
      },
    }
    const m = ctx.mount(svc)
    expect(log).toEqual(['up'])
    m.dispose()
    expect(log).toEqual(['up', 'down'])
    expect(m.status()).toBe('unloading')
  })

  it('mount.dispose() unwinds effects registered but not returned by apply', () => {
    const ctx = new Context()
    const log: string[] = []
    const svc: Service = {
      apply(c) {
        c.effect(() => {
          log.push('e1+')
          return () => log.push('e1-')
        })
        c.effect(() => {
          log.push('e2+')
          return () => log.push('e2-')
        })
      },
    }
    const m = ctx.mount(svc)
    expect(log).toEqual(['e1+', 'e2+'])
    m.dispose()
    expect(log).toEqual(['e1+', 'e2+', 'e2-', 'e1-'])
  })

  it('dispose() before deps arrive prevents activation', () => {
    const ctx = new Context()
    let applied = false
    const svc: Service = {
      inject: ['dep'],
      apply() {
        applied = true
      },
    }
    const m = ctx.mount(svc)
    expect(m.status()).toBe('inactive')
    m.dispose()
    ctx.provide('dep', 1)
    expect(applied).toBe(false)
  })

  it('composite service applies once even when apply triggers provide', () => {
    const ctx = new Context()
    let applied = 0
    const svc: Service = {
      inject: ['trigger'],
      apply(c) {
        applied++
        c.provide('mid', 42)
      },
    }
    ctx.mount(svc)
    ctx.provide('trigger', 1)
    expect(applied).toBe(1)
    expect(ctx.get('mid')).toBe(42)
  })
})
