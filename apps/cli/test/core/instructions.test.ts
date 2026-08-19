import { describe, it, expect } from 'vitest'
import { InstructionsLoader } from '../../src/core/instructions'

describe('InstructionsLoader.buildSystemPrompt', () => {
  it('injects the commit-attribution instruction (AI 署名披露)', () => {
    const prompt = new InstructionsLoader().buildSystemPrompt()
    expect(prompt).toContain('Commit Attribution')
    expect(prompt).toContain('Co-Authored-By: Mipham <noreply@mipham.ai>')
  })
})
