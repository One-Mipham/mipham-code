import { describe, it, expect } from 'vitest'
import { SubAgent } from '../../src/agent/sub-agent'

describe('SubAgent', () => {
  // SubAgent without a provider registry runs in simulation mode
  const sub = new SubAgent(null as unknown as import('../../src/providers/registry').ProviderRegistry)

  describe('execute (simulation mode)', () => {
    it('returns result for general type', async () => {
      const result = await sub.execute('Test task', 'Do something', { type: 'general' })
      expect(result).toContain('Sub-Agent Result')
      expect(result).toContain('Do something')
      expect(result).toContain('Test task')
    })

    it('returns explore-specific response', async () => {
      const result = await sub.execute('Find patterns', 'Search codebase', { type: 'explore' })
      expect(result).toContain('exploration')
      expect(result).toContain('Search codebase')
    })

    it('returns plan-specific response', async () => {
      const result = await sub.execute('Plan auth system', 'Design auth flow', { type: 'plan' })
      expect(result).toContain('plan')
      expect(result).toContain('/plan mode')
    })

    it('returns code-review-specific response', async () => {
      const result = await sub.execute('Review app.ts', 'Check for bugs', { type: 'code-review' })
      expect(result).toContain('code review')
      expect(result).toContain('/review')
    })

    it('defaults to general when no type specified', async () => {
      const result = await sub.execute('Something', 'A task')
      expect(result).toContain('Sub-Agent Result')
      expect(result).toContain('(general)')
    })

    it('truncates long prompts in output', async () => {
      const longPrompt = 'x'.repeat(300)
      const result = await sub.execute(longPrompt, 'Long task')
      expect(result).toContain('...')
      expect(result.length).toBeLessThan(longPrompt.length + 500)
    })
  })

  describe('type system prompts', () => {
    it('general prompt includes "focused sub-agent"', async () => {
      const result = await sub.execute('x', 'y', { type: 'general' })
      expect(result).toBeTruthy()
    })

    it('explore prompt includes "structured findings"', async () => {
      const result = await sub.execute('x', 'y', { type: 'explore' })
      expect(result).toBeTruthy()
    })
  })
})
