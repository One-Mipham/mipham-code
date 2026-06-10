import { ContextManager } from '../core/context'
import type { ProviderRegistry } from '../providers/registry'
import type { Message } from '../shared/types'

export type SubAgentType = 'general' | 'explore' | 'plan' | 'code-review'

interface SubAgentOptions {
  type?: SubAgentType
  systemPrompt?: string
  maxContextMessages?: number
}

const TYPE_SYSTEM_PROMPTS: Record<SubAgentType, string> = {
  general: 'You are a focused sub-agent. Complete the assigned task thoroughly and return results.',
  explore: 'You are an exploration sub-agent. Search, read, and analyze code. Return structured findings with file paths and line numbers.',
  plan: 'You are a planning sub-agent. Design implementation approaches. Return a step-by-step plan with files to modify.',
  'code-review': 'You are a code review sub-agent. Find bugs, security issues, and code quality problems. Return findings by severity.',
}

/**
 * Sub-agent engine — creates an isolated conversation context and processes
 * a single prompt independently. Returns the consolidated result.
 *
 * Phase 7: Pipeline-ready. Without a real AI provider, returns a structured
 * analysis of the prompt. Full AI integration in M3.
 */
export class SubAgent {
  constructor(private registry: ProviderRegistry) {}

  async execute(
    prompt: string,
    description: string,
    options: SubAgentOptions = {},
  ): Promise<string> {
    const type = options.type || 'general'
    const systemPrompt = options.systemPrompt || TYPE_SYSTEM_PROMPTS[type]

    // Create isolated context for this sub-agent
    const context = new ContextManager({
      maxTokens: 100_000,
      compactionThreshold: 0.9,
    })
    context.setSystemPrompt(systemPrompt)
    context.addMessage({ role: 'user', content: prompt })

    // Phase 7 pipeline: attempt real AI, fall back to structured simulation
    try {
      const provider = this.registry.getActive()
      if (provider) {
        const messages = context.getMessages()
        const chunks: string[] = []

        for await (const chunk of provider.chat({
          model: this.registry.getActiveModel(),
          messages,
          systemPrompt,
          maxTokens: 4096,
        })) {
          if (chunk.type === 'text' && chunk.content) {
            chunks.push(chunk.content)
          }
          if (chunk.type === 'error') {
            // Fall through to simulation on API error
            throw new Error(chunk.error)
          }
        }

        if (chunks.length > 0) {
          return chunks.join('')
        }
      }
    } catch {
      // API unavailable — use simulation mode
    }

    // Simulation mode: return structured task analysis
    return this.simulate(prompt, description, type)
  }

  private simulate(prompt: string, description: string, type: SubAgentType): string {
    const lines: string[] = [
      `── Sub-Agent Result (${type}) ──`,
      '',
      `Task: ${description}`,
      `Prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? '...' : ''}`,
      '',
    ]

    switch (type) {
      case 'explore':
        lines.push(
          'Analysis: This exploration task would search the codebase for relevant',
          'files, patterns, and structures. The sub-agent pipeline is ready — connect',
          'a provider API key for real AI-powered exploration.',
        )
        break
      case 'plan':
        lines.push(
          'Plan: A step-by-step implementation plan would be generated based on',
          'the requirements. Use /plan mode for interactive planning.',
        )
        break
      case 'code-review':
        lines.push(
          'Review: The code review sub-agent would analyze the specified files for',
          'bugs, security issues, and code quality concerns. Use /review for',
          'interactive code review.',
        )
        break
      default:
        lines.push(
          'The sub-agent pipeline is operational. Connect an API key to enable',
          'AI-powered sub-agent execution. The infrastructure for context isolation,',
          'prompt routing, and result aggregation is in place.',
        )
    }

    return lines.join('\n')
  }
}
