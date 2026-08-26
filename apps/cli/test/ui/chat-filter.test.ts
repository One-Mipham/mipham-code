import { describe, it, expect } from 'vitest'
import { filterSystemMessages } from '../../src/ui/chat'
import type { ChatMessage } from '../../src/ui/app'

describe('filterSystemMessages', () => {
  it('keeps user prompts and assistant answers', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    expect(filterSystemMessages(msgs)).toEqual(msgs)
  })

  it('drops system text messages (thinking, notices, errors, command output)', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: '💭 thinking…' },
      { role: 'system', content: '⏰ Wakeup scheduled in 1m' },
      { role: 'assistant', content: 'answer' },
    ]
    expect(filterSystemMessages(msgs)).toEqual([{ role: 'assistant', content: 'answer' }])
  })

  it('drops tool activity (system role with toolMeta)', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'system',
        content: '',
        toolMeta: { name: 'Bash', input: 'echo hi', collapsed: false },
      },
      { role: 'assistant', content: 'done' },
    ]
    expect(filterSystemMessages(msgs)).toEqual([{ role: 'assistant', content: 'done' }])
  })

  it('returns empty when every message is system noise', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'Usage: /loop …' }]
    expect(filterSystemMessages(msgs)).toEqual([])
  })
})
