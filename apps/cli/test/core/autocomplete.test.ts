import { describe, it, expect } from 'vitest'
import type { Llm } from '../../src/providers/llm'
import {
  buildAutocompleteRequest,
  extractCompletion,
  shouldAutocomplete,
  requestSuggestion,
  AUTOCOMPLETE_MAX_CONTEXT,
  AUTOCOMPLETE_MAX_CHARS_PER_MESSAGE,
} from '../../src/core/autocomplete'

function textLlm(text: string): Llm {
  return {
    chat: async function* () {
      yield { type: 'text', content: text }
      yield { type: 'stop' }
    },
  }
}

describe('buildAutocompleteRequest', () => {
  it('拼出续写请求：active model + 限长 + 尾含待续写输入', () => {
    const req = buildAutocompleteRequest(
      [
        { role: 'user', content: '写一个排序函数' },
        { role: 'assistant', content: '好的' },
      ],
      '请用快速',
    )
    expect(req.model).toBe('')
    expect(req.temperature).toBe(0)
    expect(req.maxTokens).toBe(64)
    expect(req.systemPrompt).toContain('续写')
    expect(req.messages[req.messages.length - 1]).toEqual({ role: 'user', content: '请用快速' })
  })

  it('只带最近 N 条上下文', () => {
    const recent = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      content: `msg ${i}`,
    }))
    const req = buildAutocompleteRequest(recent, 'x')
    // AUTOCOMPLETE_MAX_CONTEXT 条 + 当前输入
    expect(req.messages.length).toBe(AUTOCOMPLETE_MAX_CONTEXT + 1)
  })
})

describe('extractCompletion', () => {
  it('剥掉 input 前缀返回纯续写', () => {
    expect(extractCompletion('请用快速排序数组', '请用快速')).toBe('排序数组')
  })
  it('LLM 返回空 → null', () => {
    expect(extractCompletion('  ', 'x')).toBeNull()
  })
  it('返回仅前缀 → null', () => {
    expect(extractCompletion('请用快速', '请用快速')).toBeNull()
  })
  it('不重复前缀时原样返回', () => {
    expect(extractCompletion('排序数组', '请用快速')).toBe('排序数组')
  })
})

describe('shouldAutocomplete', () => {
  it('空 / / 开头 / @ 开头 / loading / picker → false', () => {
    expect(shouldAutocomplete('', false, false)).toBe(false)
    expect(shouldAutocomplete('/help', false, false)).toBe(false)
    expect(shouldAutocomplete('@alice', false, false)).toBe(false)
    expect(shouldAutocomplete('正常', true, false)).toBe(false)
    expect(shouldAutocomplete('正常', false, true)).toBe(false)
  })
  it('正常自由文本 → true', () => {
    expect(shouldAutocomplete('写一个', false, false)).toBe(true)
  })
})

describe('requestSuggestion', () => {
  it('返回剥前缀后的续写', async () => {
    const s = await requestSuggestion(textLlm('请用快速排序数组'), [], '请用快速', () => false)
    expect(s).toBe('排序数组')
  })
  it('stale → null（丢弃过期结果）', async () => {
    const s = await requestSuggestion(textLlm('排序数组'), [], 'x', () => true)
    expect(s).toBeNull()
  })
  it('LLM 返回空 → null', async () => {
    const s = await requestSuggestion(textLlm(''), [], 'x', () => false)
    expect(s).toBeNull()
  })
})

describe('上下文的代价有上限 —— 按字符，不只按条数', () => {
  it('超长消息只带尾部，并标出被截断', () => {
    const content = 'A'.repeat(5000) + 'TAIL'
    const req = buildAutocompleteRequest([{ role: 'assistant', content }], 'x')
    const sent = req.messages[0]!.content

    // 期望值本身就是「尾部」⇒ 这一条同时钉住了「留的是尾」与「加了省略号」。
    expect(sent).toBe('…' + content.slice(-AUTOCOMPLETE_MAX_CHARS_PER_MESSAGE))
  })

  it('恰好到上限的消息原样带过（不加省略号）', () => {
    const content = 'A'.repeat(AUTOCOMPLETE_MAX_CHARS_PER_MESSAGE)
    const req = buildAutocompleteRequest([{ role: 'assistant', content }], 'x')
    expect(req.messages[0]!.content).toBe(content)
  })

  it('待续写的当前输入不截断 —— 它是被续写的那条本身', () => {
    const input = 'B'.repeat(5000)
    const req = buildAutocompleteRequest([], input)
    expect(req.messages[req.messages.length - 1]!.content).toBe(input)
  })
})

describe('用户继续打字时，这条补全当场断掉（不是读完之后才判）', () => {
  /**
   * 会数自己产了多少块的流。这个计数是**唯一**能分辨两种实现的读数：
   * 「循环内判 stale」与「循环外判 stale」**都会**走到 finally、**都会**返回 null，
   * 区别只在**上游被消费了多少**。
   */
  function countingLlm(): { llm: Llm; produced: () => number } {
    let produced = 0
    return {
      produced: () => produced,
      llm: {
        chat: async function* () {
          for (let i = 0; i < 100; i++) {
            produced++
            yield { type: 'text', content: 'y' }
          }
        },
      },
    }
  }

  it('stale 时不把流读完', async () => {
    const { llm, produced } = countingLlm()
    let calls = 0
    // 第 2 次问就 stale ⇒ 相当于用户在这条流刚起步时又敲了一下
    const s = await requestSuggestion(llm, [], 'x', () => ++calls > 1)

    expect(s).toBeNull()
    expect(produced()).toBeLessThan(100)
  })

  it('一开始就 stale 时，只有计数能分辨 —— 返回值两种实现都是 null', async () => {
    const { llm, produced } = countingLlm()
    // 上一条的判据其实落在 `toBeNull` 上，不是落在计数上：那里的 stale 是「第 2 次
    // 检查才为真」，而把判挪到循环外后**检查只发生一次**，于是它从没为真过、实现
    // 干脆读完并返回了文本。这一条把 stale 设成一成立就为真 ⇒ 两种实现**都**返回
    // null、**都**会走 finally，唯一的差别只剩上游被消费了多少 —— 计数这才承重。
    const s = await requestSuggestion(llm, [], 'x', () => true)

    expect(s).toBeNull()
    expect(produced()).toBe(1)
  })

  it('不 stale 时照常读完（对照：上一条的「没读完」不是流本来就短）', async () => {
    const { llm, produced } = countingLlm()
    const s = await requestSuggestion(llm, [], 'x', () => false)

    expect(produced()).toBe(100)
    expect(s).toBe('y'.repeat(100))
  })
})
