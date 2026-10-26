import { describe, it, expect } from 'vitest'
import { estimateMessageTokens, estimateStringTokens } from '../../src/core/context-token'
import type { Message } from '../../src/shared'

// ============================================================
// 估值必须有「密集文本」那一档。
//
// 旧实现只有 CJK / 其它两档，ASCII 一律 4 字符/token —— 对 base64、hex、
// 压缩后的 JSON/SVG 来说就是 2–3 倍的**低估**：用户粘一大段 base64 时，
// 预算与压缩触发都以为还有空间，直到 provider 回一个超长错误。
//
// 注意这里刻意不测「低估了多少倍」：仓内没有 tokenizer，2 字符/token 是
// 保守下界而不是实测值。测的是**结构性事实**：长且多样的 ASCII 串比散文贵、
// 短串与单字符重复串维持原价（后者若按密集计价会贵一个数量级）。
// ============================================================

const BASE64 =
  'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODkrLw'

describe('estimateStringTokens — 密集 ASCII', () => {
  it('长且字符多样的 ASCII 串按 ~2 字符/token 计价', () => {
    const text = BASE64.repeat(4) // 344 字符、单一连续串、64 个不同字符
    expect(text.length).toBe(344)
    expect(estimateStringTokens(text)).toBe(Math.ceil(text.length / 2))
  })

  it('对照：普通散文仍是 ~4 字符/token（这条路径没有变贵）', () => {
    const prose = 'the quick brown fox jumps over the lazy dog and then goes home'
    expect(estimateStringTokens(prose)).toBe(Math.ceil(prose.length / 4))
  })

  it('单字符重复的长串不按密集计价（BPE 会把它们合并）', () => {
    expect(estimateStringTokens('A'.repeat(400))).toBe(100)
  })

  it('刚好低于长度阈值的串维持原价', () => {
    const short = BASE64.slice(0, 39)
    expect(short.length).toBe(39)
    expect(estimateStringTokens(short)).toBe(Math.ceil(39 / 4))
  })

  it('刚过阈值就换档（判据是行为，不是拼写）', () => {
    const at = BASE64.slice(0, 40)
    expect(at.length).toBe(40)
    expect(estimateStringTokens(at)).toBe(Math.ceil(40 / 2))
  })

  it('换行把密集串切断 —— 每行各自判断，而不是整块', () => {
    // 两行 base64（76 字符换行是标准 base64 的写法），每行都长且多样 ⇒ 都按密集价；
    // 换行本身仍按零散文本计价（1 字符 → 0.25 token，向上取整由总量决定）。
    const line = BASE64.slice(0, 76)
    expect(line.length).toBe(76)
    const perLine = Math.ceil(76 / 2)
    expect(estimateStringTokens(`${line}\n${line}`)).toBe(Math.ceil(perLine * 2 + 1 / 4))
  })

  it('JSON 消息体的估值跟着走（tool_use 的入参不是散文）', () => {
    const msg = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'x', name: 'Write', input: { data: BASE64.repeat(2) } }],
    } as unknown as Message
    const flat = Math.ceil(JSON.stringify(msg.content).length / 4)
    expect(estimateMessageTokens(msg)).toBeGreaterThan(flat)
  })
})
