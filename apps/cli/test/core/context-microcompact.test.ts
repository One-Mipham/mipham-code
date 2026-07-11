import { describe, it, expect } from 'vitest'
import { microcompact, shouldMicrocompact } from '../../src/core/context-microcompact'
import { NoopCacheTracker } from '../../src/core/context-token'
import type { Message } from '@mipham/shared'

function makeMessages(count: number): Message[] {
  const msgs: Message[] = []
  for (let i = 0; i < count; i++) {
    msgs.push({ role: 'user', content: `query ${i}` })
    msgs.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `${i}`, name: 'Read', input: {} }],
    })
    msgs.push({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: `${i}`, content: 'x'.repeat(500) },
      ],
    })
  }
  return msgs
}

describe('microcompact', () => {
  it('replaces old tool_result content with placeholder', () => {
    const messages = makeMessages(10)
    const cache = new NoopCacheTracker()
    const result = microcompact(messages, cache, { keepRecent: 3 })

    // First 7 pairs (21 msgs) should be compressed, last 3 pairs (9 msgs) kept
    // Each pair: user query + assistant tool_use + user tool_result
    expect(result.messages.length).toBe(messages.length) // structure preserved

    // Check first tool_result is compressed
    const firstToolResult = result.messages[2]!
    expect(firstToolResult.role).toBe('user')
    const content = firstToolResult.content
    if (Array.isArray(content)) {
      const block = content[0] as { type: string; content: string }
      expect(block.content).toBe('[earlier result omitted]')
    }
  })

  it('keeps recent messages intact', () => {
    const messages = makeMessages(10)
    const cache = new NoopCacheTracker()
    const result = microcompact(messages, cache, { keepRecent: 5 })

    // Last 5 pairs (15 messages) should be intact
    const lastToolResult = result.messages[result.messages.length - 1]!
    const content = lastToolResult.content
    if (Array.isArray(content)) {
      const block = content[0] as { type: string; content: string }
      expect(block.content).not.toBe('[earlier result omitted]')
    }
  })

  it('skips messages in prompt cache', () => {
    const messages = makeMessages(5)
    const cache = {
      isInCache: () => true,
      getStatus: () => ({ totalMessages: 0, cachedMessages: 0, cachedTokens: 0, uncachedTokens: 0 }),
      invalidate: () => {},
    }
    const result = microcompact(messages, cache, { keepRecent: 1 })

    // All messages are in cache, so none should be compressed
    for (const msg of result.messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === 'object' && (block as unknown as Record<string, unknown>).type === 'tool_result') {
            const b = block as { content: string }
            expect(b.content).not.toBe('[earlier result omitted]')
          }
        }
      }
    }
  })

  it('shouldMicrocompact returns true only when savings > loss', () => {
    const messages = makeMessages(20)
    const cache = new NoopCacheTracker()
    // With NoopCacheTracker (nothing in cache), savings should be positive
    expect(shouldMicrocompact(messages, cache, 0.7)).toBe(true)
  })
})
