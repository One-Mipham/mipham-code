import { describe, it, expect } from 'vitest'
import { messageToEvents, deriveMessages } from '../../src/core/session-log'
import type { Message } from '../../src/shared/types'

describe('messageToEvents ↔ deriveMessages round-trip', () => {
  const samples: Message[] = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!', reasoning_content: 'thinking...' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: { file_path: '/a' } }], reasoning_content: '' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'done' }] },
  ]

  it('round-trips each sample byte-identically', () => {
    for (const m of samples) {
      expect(deriveMessages(messageToEvents(m))).toEqual([m])
    }
  })

  it('round-trips a full turn sequence preserving order', () => {
    const seq = samples
    const events = seq.flatMap((m) => messageToEvents(m, 1000))
    expect(deriveMessages(events)).toEqual(seq)
  })
})
