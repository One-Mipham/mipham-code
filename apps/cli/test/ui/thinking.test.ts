import { describe, it, expect } from 'vitest'
import { formatThinking } from '../../src/ui/thinking'

describe('formatThinking', () => {
  it('returns null when thinkingText is empty, regardless of mode', () => {
    expect(formatThinking('off', '', 'Thinking')).toBeNull()
    expect(formatThinking('minimal', '', 'Thinking')).toBeNull()
    expect(formatThinking('full', '', 'Thinking')).toBeNull()
  })

  it('returns null in off mode even with thinking text', () => {
    expect(formatThinking('off', 'some reasoning', 'Thinking')).toBeNull()
  })

  it('returns a content-free "thinking…" indicator in minimal mode', () => {
    expect(formatThinking('minimal', 'a'.repeat(500), '思考中')).toBe('💭 思考中…')
  })

  it('returns the last 200 chars of thinking content in full mode', () => {
    const content = 'x'.repeat(300)
    expect(formatThinking('full', content, 'Thinking')).toBe(`💭 ${content.slice(-200)}`)
  })

  it('shows full content verbatim when under 200 chars in full mode', () => {
    expect(formatThinking('full', 'short reasoning', 'Thinking')).toBe('💭 short reasoning')
  })
})
