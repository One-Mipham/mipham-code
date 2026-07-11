import type { ProviderRegistry, ProviderInstance } from '../providers/registry'
import type { ToolDefinition } from '../shared/index.ts'
import type { SubAgentType, SubAgentOptions, AgentDefinition } from './types'
import { createAgentContext } from './agent-context'

const TYPE_SYSTEM_PROMPTS: Record<SubAgentType, string> = {
  general: 'You are a focused sub-agent. Complete the assigned task thoroughly and return results.',
  explore:
    'You are an exploration sub-agent. Search, read, and analyze code. Return structured findings with file paths and line numbers.',
  plan: 'You are a planning sub-agent. Design implementation approaches. Return a step-by-step plan with files to modify.',
  'code-review':
    'You are a code review sub-agent. Find bugs, security issues, and code quality problems. Return findings by severity.',
}

/**
 * Sub-agent engine — creates an isolated conversation context and processes
 * a single prompt independently via the active AI provider. Returns the
 * consolidated result text.
 */
export class SubAgent {
  constructor(
    private registry: ProviderRegistry,
    private toolRegistry: Map<string, ToolDefinition>,
  ) {}

  async execute(
    prompt: string,
    description: string,
    options: SubAgentOptions = {},
  ): Promise<string> {
    const provider = this.registry.getActive()
    if (!provider) {
      throw new Error('No active provider available for sub-agent execution')
    }

    const model = this.registry.getActiveModel()
    const type = options.type || 'general'
    const agentDef = options.agentDef

    // Resolve system prompt: agentDef > options.systemPrompt > builtin type
    const systemPrompt = agentDef?.systemPrompt || options.systemPrompt || TYPE_SYSTEM_PROMPTS[type]

    // Create isolated context with tool scoping
    const resolvedDef: AgentDefinition = agentDef || {
      name: type,
      description: '',
      systemPrompt,
      model: options.modelOverride || 'inherit',
      permissionMode: 'inherit',
      background: false,
      source: 'builtin',
    }
    const { context, allowedTools } = createAgentContext(
      resolvedDef,
      this.toolRegistry,
      options.maxContextMessages,
    )

    context.setSystemPrompt(systemPrompt)
    context.addMessage({ role: 'user', content: prompt })

    const messages = context.getMessages()
    const toolDefs =
      allowedTools.length > 0
        ? allowedTools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
            input_schema: t.parameters,
          }))
        : undefined

    const modelToUse = options.modelOverride || agentDef?.model || model
    // 'inherit' means use parent model
    const resolvedModel = modelToUse === 'inherit' ? model : modelToUse

    const chunks: string[] = []

    try {
      for await (const chunk of provider.chat({
        model: resolvedModel,
        messages,
        systemPrompt,
        tools: toolDefs,
        maxTokens: 4096,
      })) {
        if (chunk.type === 'text' && chunk.content) {
          chunks.push(chunk.content)
        }
        if (chunk.type === 'error') {
          throw new Error(`Sub-agent execution failed: ${chunk.error}`)
        }
        if (chunk.type === 'stop') {
          break
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Sub-agent')) {
        throw err
      }
      throw new Error(`Sub-agent execution failed: ${String(err)}`)
    }

    return chunks.join('')
  }
}
