import { describe, it, expect } from 'vitest'
import { reactiveCompact } from '../../src/core/context-compact'
import { ContextManager } from '../../src/core/context'
import type { Message } from '../../src/shared/index.ts'

describe('reactiveCompact', () => {
  it('compacts messages above threshold using summarizer', async () => {
    const context = new ContextManager({
      maxTokens: 10000,
      compactionThreshold: 0.85,
    })
    context.setSystemPrompt('You are a helpful assistant.')

    // Add messages that exceed the threshold
    for (let i = 0; i < 50; i++) {
      context.addMessage({ role: 'user', content: `Message ${i}: ` + 'x'.repeat(200) })
      context.addMessage({ role: 'assistant', content: `Response ${i}: ` + 'y'.repeat(200) })
    }

    const initialCount = context.getMessageCount()

    const summarizer = async (msgs: Message[], heading: string): Promise<string> => {
      return `Summary of ${msgs.length} messages about: ${heading}`
    }

    await reactiveCompact(context, summarizer, 'test compaction')

    const finalCount = context.getMessageCount()
    expect(finalCount).toBeLessThan(initialCount)
    // Should have at least the summary message + kept recent messages
    expect(finalCount).toBeGreaterThan(0)
  })

  it('skips compaction when below threshold', async () => {
    const context = new ContextManager({
      maxTokens: 100000,
      compactionThreshold: 0.85,
    })
    context.setSystemPrompt('You are a helpful assistant.')

    // Add few messages
    for (let i = 0; i < 5; i++) {
      context.addMessage({ role: 'user', content: `Hello ${i}` })
      context.addMessage({ role: 'assistant', content: `Hi ${i}` })
    }

    const initialCount = context.getMessageCount()

    let called = false
    const summarizer = async (_msgs: Message[], _heading: string): Promise<string> => {
      called = true
      return 'should not be called'
    }

    await reactiveCompact(context, summarizer, 'test')
    expect(called).toBe(false)
    expect(context.getMessageCount()).toBe(initialCount)
  })

  it('preserves system prompt after compaction', async () => {
    const context = new ContextManager({
      maxTokens: 10000,
      compactionThreshold: 0.85,
    })
    const sysPrompt = 'You are a specialized coding assistant.'
    context.setSystemPrompt(sysPrompt)

    for (let i = 0; i < 50; i++) {
      context.addMessage({ role: 'user', content: `Message ${i}: ` + 'x'.repeat(200) })
      context.addMessage({ role: 'assistant', content: `Response ${i}: ` + 'y'.repeat(200) })
    }

    const summarizer = async (msgs: Message[], heading: string): Promise<string> => {
      return `Summary: ${msgs.length} messages, ${heading}`
    }

    await reactiveCompact(context, summarizer, 'test')
    expect(context.getSystemPrompt()).toBe(sysPrompt)
  })
})
