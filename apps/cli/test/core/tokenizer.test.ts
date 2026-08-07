import { describe, it, expect, beforeEach } from 'vitest'
import { TokenCounter } from '../../src/core/tokenizer'

describe('TokenCounter', () => {
  let counter: TokenCounter

  beforeEach(() => {
    counter = new TokenCounter()
  })

  it('counts empty string as 0', async () => {
    expect(await counter.count('')).toBe(0)
  })

  it('counts simple English text', async () => {
    const tokens = await counter.count('Hello, world!')
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(10)
  })

  it('counts Chinese text', async () => {
    const tokens = await counter.count('你好世界')
    expect(tokens).toBeGreaterThan(0)
  })

  it('sync count falls back to chars/4 heuristic', () => {
    const text = 'Hello, this is a test message'
    const tokens = counter.countSync(text)
    expect(tokens).toBe(Math.ceil(text.length / 4))
  })

  it('countMessages sums all message tokens', async () => {
    const msgs = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there!' },
    ]
    const tokens = await counter.countMessages(msgs)
    const hello = await counter.count('Hello')
    const hithere = await counter.count('Hi there!')
    expect(tokens).toBeGreaterThanOrEqual(hello + hithere + 8)
  })

  it('uses cache for repeated text', async () => {
    const text = 'This is a test message that should be cached'
    const first = await counter.count(text)
    const second = await counter.count(text)
    expect(first).toBe(second)
  })

  it('truncateToTokens shortens long text', async () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve'
    const truncated = await counter.truncateToTokens(text, 3)
    expect(truncated.length).toBeLessThan(text.length)
    expect(truncated.length).toBeGreaterThan(0)
  })
})
