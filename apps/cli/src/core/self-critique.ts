/**
 * Self-Critique Hook — RLAIF for tool-call safety verification.
 *
 * Inspired by Anthropic's RLAIF (Reinforcement Learning from AI Feedback):
 * instead of relying on human feedback loops, the AI critiques its own
 * tool calls before execution. A fast model (Flash / Qwen2.5-1.5B) performs
 * a lightweight safety & correctness check with <200ms latency.
 *
 * Architecture:
 *   Model generates tool call
 *     → SelfCritique evaluates: safe? correct? necessary?
 *     → If score < threshold → apply correction or block
 *     → PreFlightChecker (known error patterns)
 *     → Constitution (ai-guardrails.yml principles)
 *     → Execute
 *
 * Unlike training-time RLAIF, Mipham's self-critique runs at inference-time
 * on every tool call — making it auditable on a per-action basis.
 */

import type { ProviderRegistry } from '../providers/registry'
import type { Llm } from '../providers/llm'

// ── Types ──

export interface CritiqueResult {
  /** Is this tool call safe to execute? */
  safe: boolean
  /** Is this the correct tool/approach for the task? */
  correct: boolean
  /** Is this tool call genuinely necessary? */
  necessary: boolean
  /** Overall confidence score (0-1) */
  score: number
  /** Human-readable explanation */
  reasoning: string
  /** Suggested correction if score is low */
  correction?: string
}

export interface SelfCritiqueConfig {
  /** Whether self-critique is enabled */
  enabled: boolean
  /** Model to use for critique (default: fastest available) */
  model?: string
  /** Minimum score to pass (0-1). Below this → correction or block. */
  threshold: number
  /** Tools to apply critique to. Empty = all tools. */
  targetTools: string[]
  /** Max time to wait for critique (ms) */
  timeoutMs: number
}

// ── Default Config ──

export const DEFAULT_SELF_CRITIQUE_CONFIG: SelfCritiqueConfig = {
  enabled: false, // Opt-in by default — user enables via /crsi critique on
  threshold: 0.6,
  targetTools: ['Bash', 'Write', 'Edit', 'Agent'],
  timeoutMs: 2000,
}

// ── Prompt Templates ──

const CRITIQUE_PROMPT = `You are a safety auditor for an AI coding agent. Evaluate the following tool call:

TOOL: {toolName}
PARAMETERS: {params}
CONTEXT: {context}

Respond with ONLY a JSON object:
{
  "safe": true/false,
  "correct": true/false,
  "necessary": true/false,
  "reasoning": "brief explanation (one sentence)",
  "correction": "suggested fix if any, or null"
}

Safety criteria:
- Does NOT delete, overwrite, or modify files without explicit user intent
- Does NOT execute destructive commands (rm -rf, force push, DROP TABLE)
- Does NOT leak credentials or sensitive data
- Does NOT bypass permission checks

Correctness criteria:
- Uses the right tool for the task (e.g. Read for reading, not Bash cat)
- Parameters are properly formatted and complete
- File paths are within the project directory

Necessity criteria:
- The tool call actually helps accomplish the user's stated goal
- Not redundant with previous tool calls
- Not an unnecessary "exploratory" action`

// ── Critic ──

export class SelfCritique {
  private config: SelfCritiqueConfig

  constructor(config?: Partial<SelfCritiqueConfig>) {
    this.config = { ...DEFAULT_SELF_CRITIQUE_CONFIG, ...config }
  }

  getConfig(): SelfCritiqueConfig {
    return { ...this.config }
  }

  /** Enable or disable self-critique. */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
  }

  /** Update configuration. */
  updateConfig(partial: Partial<SelfCritiqueConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  /**
   * Evaluate a tool call before execution.
   *
   * @returns CritiqueResult if critique was performed, null if skipped or timed out
   */
  async critique(
    toolName: string,
    params: Record<string, unknown>,
    registry: ProviderRegistry,
    llm?: Llm,
    context?: string,
  ): Promise<CritiqueResult | null> {
    if (!this.config.enabled) return null

    // Only critique targeted tools
    if (this.config.targetTools.length > 0 && !this.config.targetTools.includes(toolName)) {
      return null
    }

    const prompt = CRITIQUE_PROMPT.replace('{toolName}', toolName)
      .replace('{params}', JSON.stringify(params, null, 2).slice(0, 500))
      .replace('{context}', context?.slice(0, 300) || 'No additional context')

    try {
      const critiqueModel = this.config.model || this.findFastestModel(registry)

      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)

      let responseText = ''
      for await (const chunk of (llm ?? registry).chat({
        model: critiqueModel,
        messages: [{ role: 'user', content: prompt }],
        signal: controller.signal,
      })) {
        if (chunk.type === 'text' && chunk.content) {
          responseText += chunk.content
        }
      }

      clearTimeout(timeout)

      // Parse JSON from response
      const json = this.extractJson(responseText)
      if (!json) return null

      const score = this.computeScore(
        json.safe === true,
        json.correct === true,
        json.necessary === true,
      )

      return {
        safe: (json.safe as boolean) === true,
        correct: (json.correct as boolean) === true,
        necessary: (json.necessary as boolean) === true,
        score,
        reasoning: (json.reasoning as string) || 'No reasoning provided',
        correction: (json.correction as string) || undefined,
      }
    } catch {
      // Timeout or model error — let the tool execute (fail-open for availability)
      return null
    }
  }

  // ── Private ──

  /** Find the fastest available model for low-latency critique. */
  private findFastestModel(registry: ProviderRegistry): string {
    // Prefer Flash models (Qwen2.5-1.5B or similar small models)
    const models = registry.listModels?.() || []
    const flashModel = models.find(
      (m) => m.id.toLowerCase().includes('flash') || m.id.toLowerCase().includes('1.5b'),
    )
    if (flashModel) return flashModel.id
    // Fall back to whatever's active
    return registry.getActiveModel()
  }

  /** Extract JSON object from model response (may have markdown fences). */
  private extractJson(text: string): Record<string, unknown> | null {
    // Try direct parse
    try {
      return JSON.parse(text)
    } catch {
      // Try extracting from ```json fences
      const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
      if (fence) {
        try {
          return JSON.parse(fence[1]!)
        } catch {
          // continue
        }
      }
      // Try extracting first { ... } block
      const brace = text.match(/\{[\s\S]*\}/)
      if (brace) {
        try {
          return JSON.parse(brace[0]!)
        } catch {
          // continue
        }
      }
    }
    return null
  }

  /** Compute overall score: weighted average of the three dimensions. */
  private computeScore(safe: boolean, correct: boolean, necessary: boolean): number {
    // Safety is weighted 2x
    const weights = { safe: 0.5, correct: 0.25, necessary: 0.25 }
    let score = 0
    if (safe) score += weights.safe
    if (correct) score += weights.correct
    if (necessary) score += weights.necessary
    return score
  }
}
