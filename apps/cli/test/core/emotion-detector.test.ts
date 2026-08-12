/**
 * EmotionDetector tests — regex-based user frustration/impatience/confusion detection.
 *
 * Pure regex matching, zero latency, no LLM calls. Every emotion type
 * and key edge case covered.
 */

import { describe, it, expect } from 'vitest'
import { EmotionDetector } from '../../src/core/emotion-detector.js'

describe('EmotionDetector', () => {
  const detector = new EmotionDetector()

  // ── Frustration ──

  describe('frustration detection', () => {
    it('detects profanity', () => {
      const r = detector.detect('wtf this is broken')
      expect(r.emotion).toBe('frustrated')
      expect(r.confidence).toBeGreaterThanOrEqual(0.5)
      expect(r.triggers).toContain('profanity')
    })

    it('detects strong negative words', () => {
      const r = detector.detect('this tool is completely useless')
      expect(r.emotion).toBe('frustrated')
      expect(r.triggers).toContain('strong-negative')
    })

    it('detects "just fix it" impatience', () => {
      const r = detector.detect('just fix it already')
      expect(r.emotion).toBe('frustrated')
      expect(r.triggers).toContain('just-fix-it')
    })

    it('detects emphatic no with exclamation', () => {
      const r = detector.detect('No!! That is wrong!')
      expect(r.emotion).toBe('frustrated')
      expect(r.triggers).toContain('emphatic-no')
    })

    it('detects repeated failure frustration', () => {
      const r = detector.detect('not again!! why is this still broken?')
      expect(r.emotion).toBe('frustrated')
      expect(r.triggers).toContain('repeated-failure')
    })

    it('detects multiple exclamation marks as mild frustration', () => {
      const r = detector.detect('the build failed!!')
      expect(r.emotion).toBe('frustrated')
      expect(r.triggers).toContain('multiple-exclamation')
    })

    it('detects "i already said" frustration', () => {
      const r = detector.detect('I already told you to use pnpm not npm')
      expect(r.emotion).toBe('frustrated')
      expect(r.triggers).toContain('i-already-said')
    })

    it('provides concise behavior suggestion for frustrated user', () => {
      const r = detector.detect('wtf this is garbage just fix it')
      expect(r.suggestion).toMatch(/concise/i)
    })
  })

  // ── Impatience ──

  describe('impatience detection', () => {
    it('detects speed words', () => {
      const r = detector.detect('hurry up this is urgent')
      expect(r.emotion).toBe('impatient')
      expect(r.triggers).toContain('speed-words')
    })

    it('detects "just the code" request', () => {
      const r = detector.detect('just the code please')
      expect(r.emotion).toBe('impatient')
      expect(r.triggers).toContain('just-the-result')
    })

    it('detects "skip explanation"', () => {
      const r = detector.detect('skip the explanation and show me the result')
      expect(r.emotion).toBe('impatient')
      expect(r.triggers).toContain('skip-explanation')
    })

    it('detects tldr request', () => {
      const r = detector.detect('tldr what changed?')
      expect(r.emotion).toBe('impatient')
      expect(r.triggers).toContain('tldr')
    })
  })

  // ── Confusion ──

  describe('confusion detection', () => {
    it('detects explicit confusion', () => {
      const r = detector.detect("I don't understand what this does")
      expect(r.emotion).toBe('confused')
      expect(r.triggers).toContain('explicit-confusion')
    })

    it('detects "what is" questions', () => {
      const r = detector.detect('what does this function do?')
      expect(r.emotion).toBe('confused')
      expect(r.triggers).toContain('what-is-question')
    })

    it('detects "can you explain" as confusion', () => {
      const r = detector.detect('can you explain this in more detail?')
      expect(r.emotion).toBe('confused')
      expect(r.triggers).toContain('ask-for-explanation')
    })

    it('provides explanation-oriented suggestion', () => {
      const r = detector.detect("I'm confused about the architecture")
      expect(r.suggestion).toMatch(/explain/i)
    })
  })

  // ── Satisfaction ──

  describe('satisfaction detection', () => {
    it('detects thanks', () => {
      const r = detector.detect('thank you so much!')
      expect(r.emotion).toBe('satisfied')
      expect(r.triggers).toContain('thanks')
    })

    it('detects praise', () => {
      const r = detector.detect('great job, this is perfect!')
      expect(r.emotion).toBe('satisfied')
      // Should contain at least one positive trigger
      expect(r.triggers.length).toBeGreaterThanOrEqual(1)
    })

    it('detects positive emoji', () => {
      const r = detector.detect('works perfectly now! 🎉')
      expect(r.emotion).toBe('satisfied')
      expect(r.triggers).toContain('positive-emoji')
    })
  })

  // ── Neutral ──

  describe('neutral detection', () => {
    it('returns neutral for ordinary technical questions', () => {
      const r = detector.detect('How do I add a new tool definition to the engine?')
      expect(r.emotion).toBe('neutral')
      expect(r.confidence).toBe(0)
    })

    it('returns neutral for simple commands', () => {
      const r = detector.detect('commit and push')
      expect(r.emotion).toBe('neutral')
    })

    it('returns neutral for factual statements', () => {
      const r = detector.detect('The test suite has 1168 passing tests.')
      expect(r.emotion).toBe('neutral')
    })
  })

  // ── isFrustrated quick check ──

  describe('isFrustrated quick check', () => {
    it('returns true for frustrated input', () => {
      expect(detector.isFrustrated('wtf this is broken')).toBe(true)
    })

    it('returns false for neutral input', () => {
      expect(detector.isFrustrated('please add a test for this function')).toBe(false)
    })
  })

  // ── Escalation detection ──

  describe('escalation detection', () => {
    it('detects 2+ consecutive frustrated turns', () => {
      const recent = ['wtf this is broken', 'still not working!!!', 'add a test please']
      expect(detector.detectEscalation(recent)).toBe(true)
    })

    it('returns false for single frustration turn', () => {
      const recent = ['wtf this is broken', 'ok let me try another approach']
      expect(detector.detectEscalation(recent)).toBe(false)
    })

    it('returns false for short history (< 2 turns)', () => {
      expect(detector.detectEscalation(['wtf'])).toBe(false)
    })
  })

  // ── Mixed signals: frustration wins ──

  describe('emotion priority', () => {
    it('frustration overrides thanks (user is being sarcastic)', () => {
      const r = detector.detect('thanks for nothing, this is garbage')
      expect(r.emotion).toBe('frustrated')
    })

    it('frustration overrides confusion', () => {
      const r = detector.detect("wtf I don't understand why this keeps failing")
      expect(r.emotion).toBe('frustrated')
    })

    it('impatience is detected even with polite language', () => {
      const r = detector.detect('please skip the explanation and just show me the fix')
      expect(r.emotion).toBe('impatient')
    })
  })
})
