import { describe, it, expect } from 'vitest'
import { Context } from '../../src/vajra/context'

// 测试用事件契约（declaration merging 扩展内核的 EventMap）
declare module '../../src/vajra/events' {
  interface EventMap {
    't/emit': { mode: 'emit' }
    't/wf': { mode: 'waterfall' }
    't/p': { mode: 'parallel' }
    't/s': { mode: 'serial' }
  }
}

describe('Context event dispatch', () => {
  it('emit fires listeners in registration order', () => {
    const ctx = new Context()
    const order: string[] = []
    ctx.on('t/emit', () => order.push('a'))
    ctx.on('t/emit', () => order.push('b'))
    ctx.emit('t/emit')
    expect(order).toEqual(['a', 'b'])
  })

  it('on() returns a disposer that removes the listener', () => {
    const ctx = new Context()
    const calls: string[] = []
    const off = ctx.on('t/emit', () => calls.push('x'))
    off()
    ctx.emit('t/emit')
    expect(calls).toEqual([])
  })

  it('waterfall chains values and can short-circuit', async () => {
    const ctx = new Context()
    ctx.on('t/wf', async (v: number, next: (n?: number) => Promise<number>) => next(v + 1))
    ctx.on('t/wf', async (v: number, next: (n?: number) => Promise<number>) => next(v * 10))
    await expect(ctx.waterfall<number>('t/wf', 1)).resolves.toBe(20)

    const guard = new Context()
    guard.on('t/wf', async (v: number, next: (n?: number) => Promise<number>) => {
      if (v === 1) return -1
      return next(v)
    })
    guard.on('t/wf', async (v: number, next: (n?: number) => Promise<number>) => next(v + 1))
    await expect(guard.waterfall<number>('t/wf', 1)).resolves.toBe(-1)
  })

  it('parallel runs concurrently, serial runs in order', async () => {
    const p = new Context()
    const pOrder: string[] = []
    p.on('t/p', async () => {
      await new Promise((r) => setTimeout(r, 30))
      pOrder.push('slow')
    })
    p.on('t/p', async () => {
      pOrder.push('fast')
    })
    await p.parallel('t/p')
    expect(pOrder[0]).toBe('fast')

    const s = new Context()
    const sOrder: string[] = []
    s.on('t/s', async () => {
      await new Promise((r) => setTimeout(r, 30))
      sOrder.push('slow')
    })
    s.on('t/s', async () => {
      sOrder.push('fast')
    })
    await s.serial('t/s')
    expect(sOrder).toEqual(['slow', 'fast'])
  })
})

describe('event mode is a compile-time contract', () => {
  it('dispatch methods reject wrong-mode events at the type level', () => {
    const ctx = new Context()
    ctx.emit('t/emit')
    ctx.waterfall<number>('t/wf', 1)
    // @ts-expect-error — 't/emit' 不是 waterfall 模式
    ctx.waterfall<number>('t/emit', 1)
    // @ts-expect-error — 't/wf' 不是 emit 模式
    ctx.emit('t/wf')
  })
})
