import { describe, it, expect } from 'vitest'
import { computeNextFire } from '../../src/core/cron'

// computeNextFire 是 5 字段 cron 解析器（分钟粒度），返回下一次触发时间的 ISO 串。
// 用本地时区构造 `from`，断言用 getTime() 比较（时区无关）。

function local(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  return new Date(y, mo, d, h, mi, s).getTime()
}

describe('computeNextFire', () => {
  it('matches an exact hour/minute on the next day when the minute already passed', () => {
    const result = computeNextFire('0 9 * * *', new Date(2026, 0, 1, 0, 0, 0))
    expect(new Date(result).getTime()).toBe(local(2026, 0, 1, 9, 0, 0))
  })

  it('wildcard fires the next minute', () => {
    const result = computeNextFire('* * * * *', new Date(2026, 0, 1, 0, 0, 0))
    expect(new Date(result).getTime()).toBe(local(2026, 0, 1, 0, 1, 0))
  })

  it('step expression */5 fires the next multiple-of-5 minute', () => {
    const result = computeNextFire('*/5 * * * *', new Date(2026, 0, 1, 0, 0, 0))
    expect(new Date(result).getTime()).toBe(local(2026, 0, 1, 0, 5, 0))
  })

  it('range expression fires within the range', () => {
    const result = computeNextFire('30 9-10 * * *', new Date(2026, 0, 1, 9, 0, 0))
    expect(new Date(result).getTime()).toBe(local(2026, 0, 1, 9, 30, 0))
  })

  it('list expression fires the first listed hour', () => {
    const result = computeNextFire('0 9,12 * * *', new Date(2026, 0, 1, 0, 0, 0))
    expect(new Date(result).getTime()).toBe(local(2026, 0, 1, 9, 0, 0))
  })

  it('avoids matching the current minute (starts from minute+1)', () => {
    const result = computeNextFire('0 0 * * *', new Date(2026, 0, 1, 0, 0, 0))
    expect(new Date(result).getTime()).toBe(local(2026, 0, 2, 0, 0, 0))
  })

  it('falls back to +1 minute for an invalid expression', () => {
    const result = computeNextFire('not-a-cron', new Date(2026, 0, 1, 0, 0, 0))
    expect(new Date(result).getTime()).toBe(local(2026, 0, 1, 0, 1, 0))
  })
})
