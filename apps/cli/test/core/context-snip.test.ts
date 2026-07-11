import { describe, it, expect } from 'vitest'
import { snipMessages } from '../../src/core/context-snip'
import type { Message } from '@mipham/shared'

describe('snipMessages', () => {
  it('removes empty tool_result + preceding assistant pair', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '1', name: 'Read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '1', content: '' }],
      },
      { role: 'assistant', content: 'final response' },
    ]

    const result = snipMessages(messages)
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]!.content).toBe('hello')
    expect(result.messages[1]!.content).toBe('final response')
    expect(result.removed).toBe(2)
  })

  it('keeps non-empty tool_results', () => {
    const messages: Message[] = [
      { role: 'user', content: 'read file' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '1', name: 'Read', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '1', content: 'file contents here' }],
      },
      { role: 'assistant', content: 'I read the file.' },
    ]

    const result = snipMessages(messages)
    expect(result.messages).toHaveLength(4)
  })

  it('does not remove non-tool message pairs', () => {
    const messages: Message[] = [
      { role: 'user', content: 'question 1' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'question 2' },
      { role: 'assistant', content: '' }, // empty assistant
    ]

    const result = snipMessages(messages)
    // The empty assistant + preceding user pair with no tool use should stay
    // (snip only targets tool_use/tool_result patterns)
    expect(result.messages).toHaveLength(4)
  })

  it('returns unchanged array when nothing to snip', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]

    const result = snipMessages(messages)
    expect(result.messages).toHaveLength(2)
    expect(result.removed).toBe(0)
  })

  it('handles empty message array', () => {
    const result = snipMessages([])
    expect(result.messages).toHaveLength(0)
    expect(result.removed).toBe(0)
  })
})
