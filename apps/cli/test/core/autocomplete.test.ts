import { describe, it, expect } from 'vitest'
import type { Llm } from '../../src/providers/llm'
import {
  buildAutocompleteRequest,
  extractCompletion,
  shouldAutocomplete,
  requestSuggestion,
  AUTOCOMPLETE_MAX_CONTEXT,
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
