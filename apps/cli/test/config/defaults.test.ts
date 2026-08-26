import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config/defaults'

// Locks the "clean output" window style: thinking, scheduling notices, and the
// slash-command picker are all OFF by default, so the chat shows only the user
// prompt + assistant answer (+ tool activity when the model actually calls tools).
// Reverting these to noisy defaults must be a deliberate, reviewed decision — a
// failing test here is the guardrail against accidental regression.
describe('DEFAULT_CONFIG clean-output defaults', () => {
  it('hides the reasoning/thinking indicator by default', () => {
    expect(DEFAULT_CONFIG.showThinking).toBe('off')
  })

  it('hides ⏰ scheduling notices by default', () => {
    expect(DEFAULT_CONFIG.showSchedulingNotices).toBe(false)
  })

  it('disables the slash-command picker auto-popup by default', () => {
    expect(DEFAULT_CONFIG.showCommandPicker).toBe(false)
  })
})
