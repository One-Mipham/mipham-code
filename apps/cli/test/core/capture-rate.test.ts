import { describe, it, expect } from 'vitest'
import { computeCapture, perTaskValue } from '../../src/core/capture-rate'

describe('perTaskValue', () => {
  it('k 次都合格 ⇒ 通过率（0–100）', () => {
    const m = perTaskValue(
      [
        { id: 't1', passed: true },
        { id: 't1', passed: true },
        { id: 't1', passed: false },
      ],
      3,
    )
    expect(m.get('t1')).toBeCloseTo(66.67, 2)
  })

  it('合格样本数 < k ⇒ null（配对剔除，不拿半份样本凑数）', () => {
    const m = perTaskValue(
      [
        { id: 't1', passed: true },
        { id: 't1', passed: true },
        { id: 't1', passed: false, truncated: true },
      ],
      3,
    )
    expect(m.get('t1')).toBe(null)
  })

  it('uncertain 与 truncated 一样不计入样本', () => {
    const m = perTaskValue(
      [
        { id: 't1', passed: true },
        { id: 't1', passed: false, uncertain: true },
      ],
      1,
    )
    expect(m.get('t1')).toBe(100)
  })
})

describe('computeCapture', () => {
  it('分子/分母只在有 headroom 且两侧都有样本的题上求和', () => {
    const r = computeCapture({
      off: [
        { taskId: 'a', value: 50 },
        { taskId: 'b', value: 20 },
        { taskId: 'c', value: 100 },
      ],
      on: [
        { taskId: 'a', value: 75 },
        { taskId: 'b', value: 60 },
        { taskId: 'c', value: 100 },
      ],
      total: 3,
    })
    expect(r.numerator).toBe(65)
    expect(r.denominator).toBe(130)
    expect(r.rate).toBeCloseTo(0.5, 6)
    expect(r.tasksUsed).toBe(2)
    expect(r.tasksTotal).toBe(3)
    expect(r.noHeadroom).toEqual(['c'])
    expect(r.ci).not.toBeNull()
    expect(r.ci!.lo).toBeLessThanOrEqual(r.rate!)
    expect(r.ci!.hi).toBeGreaterThanOrEqual(r.rate!)
  })

  it('一道有 headroom 的题都没有 ⇒ 没有率（不是 0、也不是 1）', () => {
    const r = computeCapture({
      off: [{ taskId: 'a', value: 100 }],
      on: [{ taskId: 'a', value: 100 }],
      total: 1,
    })
    expect(r.rate).toBe(null)
    expect(r.ci).toBe(null)
    expect(r.noHeadroom).toEqual(['a'])
  })

  it('一侧缺样本 ⇒ 该题 dropped，且不改变率', () => {
    const r = computeCapture({
      off: [
        { taskId: 'a', value: 20 },
        { taskId: 'b', value: 40 },
      ],
      on: [
        { taskId: 'a', value: 60 },
        { taskId: 'b', value: null },
      ],
      total: 2,
    })
    expect(r.dropped).toEqual(['b'])
    expect(r.rate).toBeCloseTo(40 / 80, 6)
  })

  it('no-headroom 剔除不改率：满分题与从未有过它，读数相同', () => {
    const withNoHeadroom = computeCapture({
      off: [
        { taskId: 'a', value: 100 },
        { taskId: 'b', value: 20 },
      ],
      on: [
        { taskId: 'a', value: 100 },
        { taskId: 'b', value: 60 },
      ],
      total: 2,
    })
    const withoutIt = computeCapture({
      off: [{ taskId: 'b', value: 20 }],
      on: [{ taskId: 'b', value: 60 }],
      total: 2,
    })
    expect(withNoHeadroom.rate).toBeCloseTo(withoutIt.rate!, 6)
    expect(withNoHeadroom.noHeadroom).toEqual(['a'])
    expect(withNoHeadroom.dropped).toEqual([])
  })

  it('配对剔除不改率：null 的那题与从未有过它，读数相同', () => {
    const withDropped = computeCapture({
      off: [
        { taskId: 'a', value: 20 },
        { taskId: 'b', value: null },
      ],
      on: [
        { taskId: 'a', value: 60 },
        { taskId: 'b', value: 90 },
      ],
      total: 2,
    })
    const withoutIt = computeCapture({
      off: [{ taskId: 'a', value: 20 }],
      on: [{ taskId: 'a', value: 60 }],
      total: 2,
    })
    expect(withDropped.dropped).toEqual(['b'])
    expect(withDropped.rate).toBeCloseTo(withoutIt.rate!, 6)
  })

  it('正对照：on ≡ off 且有 headroom ⇒ 捕获率必须是 0', () => {
    const r = computeCapture({
      off: [
        { taskId: 'a', value: 20 },
        { taskId: 'b', value: 40 },
      ],
      on: [
        { taskId: 'a', value: 20 },
        { taskId: 'b', value: 40 },
      ],
      total: 2,
    })
    expect(r.rate).toBe(0)
  })

  it('同一输入两次计算给出同一区间（种子固定）', () => {
    const input = {
      off: [
        { taskId: 'a', value: 20 },
        { taskId: 'b', value: 40 },
        { taskId: 'c', value: 60 },
      ],
      on: [
        { taskId: 'a', value: 60 },
        { taskId: 'b', value: 60 },
        { taskId: 'c', value: 60 },
      ],
      total: 3,
    }
    expect(computeCapture(input).ci).toEqual(computeCapture(input).ci)
  })
})
