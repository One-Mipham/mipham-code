/**
 * Emotion Detector — User Frustration Detection
 *
 * Inspired by Claude Code's emotion detection: parses user input for signals
 * of frustration, confusion, or satisfaction. Adjusts agent behavior accordingly:
 *   - Frustration → be more concise, skip explanations, get to the fix faster
 *   - Confusion → explain more, offer context, slow down
 *   - Satisfaction → maintain current mode
 *
 * Uses regex heuristics (no LLM call) for zero-latency detection.
 * Designed as a lightweight pre-processor in the input pipeline.
 */

// ── Types ──

export type Emotion =
  | 'frustrated' // User is angry/annoyed — move fast, skip explanations
  | 'confused' // User doesn't understand — explain more
  | 'impatient' // User wants speed — be terse
  | 'satisfied' // User is happy — continue normally
  | 'neutral' // No strong signal

export interface EmotionResult {
  emotion: Emotion
  /** 0.0-1.0 confidence in the detected emotion */
  confidence: number
  /** Specific phrases that triggered the detection */
  triggers: string[]
  /** Suggested behavior adjustment for the agent */
  suggestion: string
}

// ── Constants ──

/** Patterns that indicate frustration/anger. Ordered by severity. */
const FRUSTRATION_PATTERNS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /\b(wtf|wtaf)\b/i, weight: 0.9, label: 'profanity' },
  {
    pattern: /\b(useless|worthless|garbage|rubbish|broken)\b/i,
    weight: 0.8,
    label: 'strong-negative',
  },
  { pattern: /\b(damn|shit|crap)\b/i, weight: 0.7, label: 'mild-profanity' },
  {
    pattern: /\b(stop|don't|do not)\s+(explain|talk|lecture|ramble)\b/i,
    weight: 0.85,
    label: 'stop-explaining',
  },
  {
    pattern: /\b(just\s+fix\s+it|just\s+do\s+it|get\s+on\s+with\s+it)\b/i,
    weight: 0.8,
    label: 'just-fix-it',
  },
  {
    pattern: /\b(no|wrong|incorrect|bad|terrible|awful)\s*[!！]{1,3}/i,
    weight: 0.75,
    label: 'emphatic-no',
  },
  { pattern: /\b(again\?|still|not\s+again)\b/i, weight: 0.7, label: 'repeated-failure' },
  { pattern: /\b(i\s+said|i\s+told\s+you|i\s+already)\b/i, weight: 0.75, label: 'i-already-said' },
  { pattern: /\b(no\s+no\s+no|nope\s+nope)\b/i, weight: 0.7, label: 'repeated-no' },
  { pattern: /[！!]{2,}/, weight: 0.6, label: 'multiple-exclamation' },
  {
    pattern: /\b(why|why\s+would\s+you|what\s+are\s+you\s+doing)\b/i,
    weight: 0.65,
    label: 'why-question',
  },
  { pattern: /[？?]{2,}/, weight: 0.4, label: 'multiple-question-marks' },
]

/** Patterns that indicate confusion / need for more explanation */
const CONFUSION_PATTERNS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  {
    pattern: /\b(i\s+don'?t\s+understand|i\s+am\s+confused|i'?m\s+confused)\b/i,
    weight: 0.9,
    label: 'explicit-confusion',
  },
  {
    pattern: /\b(what\s+does|what\s+is|what\s+are|how\s+does)\b/i,
    weight: 0.6,
    label: 'what-is-question',
  },
  {
    pattern: /\b(can\s+you\s+explain|explain\s+this|elaborate)\b/i,
    weight: 0.7,
    label: 'ask-for-explanation',
  },
  { pattern: /\b(wait|huh|eh\?+|hmm+)\b/i, weight: 0.5, label: 'hesitation' },
  {
    pattern: /\b(i\s+thought|i\s+expected|shouldn'?t\s+it)\b/i,
    weight: 0.6,
    label: 'mismatch-expectation',
  },
]

/** Patterns that indicate impatience */
const IMPATIENCE_PATTERNS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /\b(hurry|quick|fast|faster|asap|urgent)\b/i, weight: 0.8, label: 'speed-words' },
  {
    pattern: /\b(just\s+the\s+(code|answer|result|fix|summary))\b/i,
    weight: 0.75,
    label: 'just-the-result',
  },
  {
    pattern: /\b(skip\s+(the\s+)?(explanation|details|context|background))\b/i,
    weight: 0.8,
    label: 'skip-explanation',
  },
  { pattern: /\b(tldr|tl;dr|summary|summarize)\b/i, weight: 0.7, label: 'tldr' },
  {
    pattern: /\b(get\s+to\s+the\s+point|cut\s+to\s+the\s+chase)\b/i,
    weight: 0.75,
    label: 'get-to-point',
  },
]

/** Patterns that indicate satisfaction */
const SATISFACTION_PATTERNS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /\b(thanks|thank\s+you|thx|ty|tyvm)\b/i, weight: 0.5, label: 'thanks' },
  {
    pattern: /\b(great|awesome|perfect|excellent|amazing|brilliant|beautiful)\b/i,
    weight: 0.6,
    label: 'positive-words',
  },
  { pattern: /\b(nice|good\s+job|well\s+done|love\s+it)\b/i, weight: 0.7, label: 'praise' },
  {
    pattern: /\b(exactly|finally|yes!|that'?s\s+it)\b/i,
    weight: 0.6,
    label: 'confirmation-positive',
  },
  { pattern: /[👍🙌🎉✨💯🔥✅]/u, weight: 0.5, label: 'positive-emoji' },
]

// ── Detector ──

export class EmotionDetector {
  /**
   * Analyze user input for emotional signals.
   *
   * @param input — raw user message text
   * @param recentContext — optional recent conversation turns for pattern detection
   * @returns EmotionResult with detected emotion and behavioral suggestion
   */
  detect(input: string, recentContext?: string[]): EmotionResult {
    // Check frustration first (most actionable)
    const frustration = this.scorePatterns(input, FRUSTRATION_PATTERNS, recentContext)
    if (frustration.score >= 0.5) {
      return {
        emotion: 'frustrated',
        confidence: frustration.score,
        triggers: frustration.triggers,
        suggestion:
          frustration.score >= 0.8
            ? 'User is very frustrated. Be extremely concise. Skip ALL explanations. Output only the fix/result. No preamble, no summary, no "here\'s what I did". One sentence max before code.'
            : 'User is frustrated. Be concise. Skip explanations. Get to the fix immediately.',
      }
    }

    // Check impatience
    const impatience = this.scorePatterns(input, IMPATIENCE_PATTERNS)
    if (impatience.score >= 0.5) {
      return {
        emotion: 'impatient',
        confidence: impatience.score,
        triggers: impatience.triggers,
        suggestion:
          'User wants speed. Skip explanations. Output the result immediately. No "let me explain why" — just the answer.',
      }
    }

    // Check confusion
    const confusion = this.scorePatterns(input, CONFUSION_PATTERNS)
    if (confusion.score >= 0.5) {
      return {
        emotion: 'confused',
        confidence: confusion.score,
        triggers: confusion.triggers,
        suggestion:
          'User is confused. Explain more. Offer context. Break down complex steps. Ask clarifying questions rather than assuming.',
      }
    }

    // Check satisfaction
    const satisfaction = this.scorePatterns(input, SATISFACTION_PATTERNS)
    if (satisfaction.score >= 0.5) {
      return {
        emotion: 'satisfied',
        confidence: satisfaction.score,
        triggers: satisfaction.triggers,
        suggestion:
          'User is satisfied. Maintain current tone and pace. Good time for optional suggestions.',
      }
    }

    return {
      emotion: 'neutral',
      confidence: 0,
      triggers: [],
      suggestion: 'No strong emotional signal. Proceed normally.',
    }
  }

  /**
   * Quick check — does this input contain ANY frustration signal?
   * Use as a pre-filter before the full detect() call.
   */
  isFrustrated(input: string): boolean {
    return FRUSTRATION_PATTERNS.some((p) => p.pattern.test(input))
  }

  /**
   * Detect repeated frustration across multiple turns (escalation detection).
   */
  detectEscalation(recentInputs: string[]): boolean {
    if (recentInputs.length < 2) return false
    const recent = recentInputs.slice(-3)
    const frustrationCount = recent.filter((i) => this.isFrustrated(i)).length
    return frustrationCount >= 2
  }

  // ── Internal ──

  private scorePatterns(
    input: string,
    patterns: Array<{ pattern: RegExp; weight: number; label: string }>,
    recentContext?: string[],
  ): { score: number; triggers: string[] } {
    const triggers: string[] = []
    let totalWeight = 0
    let matchCount = 0

    for (const p of patterns) {
      if (p.pattern.test(input)) {
        triggers.push(p.label)
        totalWeight += p.weight
        matchCount++
      }
    }

    // Check recent context for frustration escalation
    if (recentContext && patterns === FRUSTRATION_PATTERNS) {
      const recentFrustration = recentContext
        .slice(-2)
        .filter((ctx) => patterns.some((p) => p.pattern.test(ctx))).length
      if (recentFrustration >= 1) {
        totalWeight += 0.15 // escalation bonus
      }
    }

    // Normalize: first match passes at weight ≥ 0.5; additional matches increase confidence
    // with diminishing returns (matchCount-1 so single match = no dampening)
    const score =
      matchCount === 0
        ? 0
        : Math.min(1.0, totalWeight / (1 + Math.max(0, matchCount - 1) * 0.5))

    return { score, triggers }
  }
}
