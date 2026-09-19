import { describe, it, expect } from 'vitest'
import { formatToolDetail } from '../../src/ui/app'

/** 孤立代理码元：高代理后面没跟低代理，或低代理前面没有高代理。
 *  终端把这种半个码元渲染成 U+FFFD —— 正是「末尾半个 emoji」的形态。 */
const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/
const LONE_LOW = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

describe('formatToolDetail — 审批预览的截断必须落在码点边界', () => {
  it('Edit: 落点夹在代理对中间时不留半个 emoji', () => {
    // 59 个 ASCII 码元 + 一个代理对（2 码元）⇒ 按 UTF-16 码元切到第 60 位时，
    // 落点正好是这个 emoji 的高代理，切完就是半个字符。
    const oldString = 'a'.repeat(59) + '🌟' + 'tail'
    const detail = formatToolDetail('Edit', { file_path: '/f.ts', old_string: oldString })

    expect(detail).toContain('/f.ts:')
    expect(detail).not.toMatch(LONE_HIGH)
    expect(detail).not.toMatch(LONE_LOW)
  })

  it('Edit: 预算内放得下的 emoji 整个保留（不因避让而多切）', () => {
    // 58 + 2 = 恰好 60 个码元，本来就该原样显示。
    const oldString = 'a'.repeat(58) + '🌟'
    const detail = formatToolDetail('Edit', { file_path: '/f.ts', old_string: oldString })

    expect(detail).toBe(`/f.ts: ${oldString}`)
  })

  it('Edit: 未超预算的短文本逐字不变', () => {
    expect(formatToolDetail('Edit', { file_path: '/f.ts', old_string: 'short' })).toBe(
      '/f.ts: short',
    )
  })

  it('Agent: 描述预览用同一条边界规则', () => {
    const description = 'b'.repeat(79) + '🌟'
    const detail = formatToolDetail('Agent', { subagent_type: 'x', description })

    expect(detail).not.toMatch(LONE_HIGH)
    expect(detail).toContain('x, "')
  })

  it('未知工具: JSON 预览用同一条边界规则', () => {
    // JSON 前缀 `{"x":"` 是 6 个码元 ⇒ 73 个 e 之后第 79 位正是高代理。
    const detail = formatToolDetail('Mystery', { x: 'e'.repeat(73) + '🌟' })

    expect(detail).not.toMatch(LONE_HIGH)
    expect(detail).not.toMatch(LONE_LOW)
  })
})
