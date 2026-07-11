import { describe, it, expect, beforeEach } from 'vitest'
import { emergencyDrain, resetDrainLevel } from '../../src/core/context-drain'
import { ContextManager } from '../../src/core/context'

describe('emergencyDrain', () => {
  beforeEach(() => {
    resetDrainLevel()
  })

  it('drops 50% of messages on first attempt', async () => {
    const context = new ContextManager({
      maxTokens: 100000,
      compactionThreshold: 0.85,
    })
    context.setSystemPrompt('system')

    for (let i = 0; i < 100; i++) {
      context.addMessage({ role: 'user', content: `msg ${i}` })
      context.addMessage({ role: 'assistant', content: `resp ${i}` })
    }

    const initialCount = context.getMessageCount()
    const recovered = await emergencyDrain(context)

    expect(recovered).toBe(true)
    expect(context.getMessageCount()).toBeLessThan(initialCount)
    // Should be roughly half, plus system prompt preserved
    expect(context.getSystemPrompt()).toBe('system')
  })

  it('falls back to minimal context when drain is insufficient', async () => {
    const context = new ContextManager({
      maxTokens: 100000,
      compactionThreshold: 0.85,
    })
    context.setSystemPrompt('system')

    for (let i = 0; i < 200; i++) {
      context.addMessage({ role: 'user', content: `msg ${i}` })
      context.addMessage({ role: 'assistant', content: `resp ${i}` })
    }

    // Second drain should strip to minimal
    await emergencyDrain(context)
    await emergencyDrain(context)

    // Should be at most 5 + summary
    expect(context.getMessageCount()).toBeLessThanOrEqual(6)
    expect(context.getSystemPrompt()).toBe('system')
  })
})
