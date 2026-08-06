import type { ProviderRegistry, ProviderInstance } from '../providers/registry'
import type { ToolDefinition } from '../shared/index.ts'
import type { SubAgentType, SubAgentOptions, AgentDefinition } from './types'
import { createAgentContext } from './agent-context'
import { getBackgroundAgentRegistry } from './background-registry'
import { getMessageBus } from './message-bus'
import type { HookEngine } from '../core/hooks'
import type { PermissionSystem } from '../core/permission'

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
 *
 * Supports background execution via `runInBackground` option — when true,
 * execution is spawned as a detached promise and the method returns immediately
 * with a `[background-task:<id>]` marker.
 */
export class SubAgent {
  constructor(
    private registry: ProviderRegistry,
    private toolRegistry: Map<string, ToolDefinition>,
    private permission?: PermissionSystem,
    private hookEngine?: HookEngine,
  ) {}

  /**
   * Execute a sub-agent task.
   *
   * When `options.runInBackground` is true:
   *   - The task runs asynchronously in BackgroundAgentRegistry
   *   - Returns immediately with `[background-task:<id>]`
   *   - Results are retrievable via Task output or Agent View
   */
  async execute(
    prompt: string,
    description: string,
    options: SubAgentOptions = {},
  ): Promise<string> {
    const agentType = options.type || 'general'

    // ── Fire SubagentStart hook ──
    if (this.hookEngine) {
      await this.hookEngine.executeSubagentStart(agentType, description, 'sub-agent')
    }

    // ── Background execution path ──
    if (options.runInBackground) {
      const bgRegistry = getBackgroundAgentRegistry()

      const taskId = bgRegistry.spawn(description, agentType, async (signal) => {
        // Run the synchronous execution inside the background executor
        return this.runExecution(prompt, options, signal)
      })

      // Register completion callback for hook firing
      bgRegistry.onComplete(taskId, (task) => {
        if (this.hookEngine) {
          this.hookEngine.executeSubagentStop(
            agentType,
            description,
            taskId,
            task.status === 'completed',
            task.result || task.error,
          )
        }
      })

      return `[background-task:${taskId}]`
    }

    // ── Synchronous execution path ──
    try {
      const result = await this.runExecution(prompt, options)
      if (this.hookEngine) {
        await this.hookEngine.executeSubagentStop(agentType, description, 'sub-agent', true, result)
      }
      return result
    } catch (err) {
      if (this.hookEngine) {
        await this.hookEngine.executeSubagentStop(
          agentType,
          description,
          'sub-agent',
          false,
          String(err),
        )
      }
      throw err
    }
  }

  /**
   * Internal execution method — shared by sync and background paths.
   */
  private async runExecution(
    prompt: string,
    options: SubAgentOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    const provider = this.registry.getActive()
    if (!provider) {
      throw new Error('No active provider available for sub-agent execution')
    }

    const model = this.registry.getActiveModel()
    const agentType = options.type || 'general'
    const agentDef = options.agentDef

    // Resolve execution directory: worktree isolation or process cwd
    const execCwd = options.worktreePath || process.cwd()

    // Resolve system prompt: agentDef > options.systemPrompt > builtin type
    const systemPrompt =
      agentDef?.systemPrompt || options.systemPrompt || TYPE_SYSTEM_PROMPTS[agentType]

    // Create isolated context with tool scoping
    const resolvedDef: AgentDefinition = agentDef || {
      name: agentType,
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

    // Validate resolved model exists in registry; fall back to parent model with warning
    let finalModel = resolvedModel
    if (resolvedModel !== model) {
      const modelExists = this.registry.findModel(resolvedModel) !== undefined
      if (!modelExists) {
        const warnMsg = `Warning: model "${resolvedModel}" not found in provider registry. Falling back to "${model}".`
        console.warn(warnMsg)

        // Post warning to message bus for UI display
        const bus = getMessageBus()
        bus.post('system', 'main', `Sub-agent model fallback: ${resolvedModel} → ${model}`, warnMsg, 'warning')

        finalModel = model
      }
    }

    const chunks: string[] = []
    const MAX_TOOL_TURNS = options.maxTurns || 5

    let currentMessages = messages
    let currentSystemPrompt = systemPrompt

    try {
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        // Check abort signal
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError')
        }

        const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
        let turnText = ''

        for await (const chunk of provider.chat({
          model: finalModel,
          messages: currentMessages,
          systemPrompt: currentSystemPrompt,
          tools: toolDefs,
          maxTokens: 4096,
        })) {
          // Check abort signal mid-stream
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError')
          }

          if (chunk.type === 'text' && chunk.content) {
            turnText += chunk.content
            // Stream progress to callback if provided
            if (options.onProgress) {
              options.onProgress(chunk.content)
            }
          }
          if (chunk.type === 'tool_use' && chunk.toolUse) {
            toolUses.push({
              id: chunk.toolUse.id,
              name: chunk.toolUse.name,
              input: chunk.toolUse.input,
            })
          }
          if (chunk.type === 'error') {
            throw new Error(`Sub-agent execution failed: ${chunk.error}`)
          }
          if (chunk.type === 'stop') {
            break
          }
        }

        chunks.push(turnText)

        // No tools used — we're done
        if (toolUses.length === 0) break

        // Execute tools and build follow-up messages
        currentMessages = [
          ...currentMessages,
          {
            role: 'assistant' as const,
            content: turnText || 'Executing tools...',
          },
        ]

        for (const tu of toolUses) {
          if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError')
          }

          const tool = this.toolRegistry.get(tu.name)
          if (!tool) {
            currentMessages.push({
              role: 'user' as const,
              content: `Error: Unknown tool "${tu.name}"`,
            })
            continue
          }

          // Security: check permission before executing
          // Sub-agents run without user interaction — tools requiring approval are rejected
          if (this.permission?.needsApproval(tool, tu.input)) {
            currentMessages.push({
              role: 'user' as const,
              content:
                `Tool "${tu.name}" requires user approval (permission: ask). ` +
                `Cannot execute in non-interactive sub-agent context.`,
            })
            continue
          }

          try {
            const result = await tool.execute(tu.input, {
              cwd: execCwd,
              sessionId: 'sub-agent',
              provider: '',
              model: finalModel,
            })

            currentMessages.push({
              role: 'assistant' as const,
              content: [{ type: 'tool_use' as const, id: tu.id, name: tu.name, input: tu.input }],
            })
            currentMessages.push({
              role: 'user' as const,
              content: [
                {
                  type: 'tool_result' as const,
                  tool_use_id: tu.id,
                  content: result.success ? result.content : result.error || result.content,
                },
              ],
            })
          } catch (err) {
            currentMessages.push({
              role: 'user' as const,
              content: `Tool "${tu.name}" execution error: ${String(err)}`,
            })
          }
        }

        // Don't send system prompt on subsequent turns
        currentSystemPrompt = ''
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err
      }
      if (err instanceof Error && err.message.startsWith('Sub-agent')) {
        throw err
      }
      throw new Error(`Sub-agent execution failed: ${String(err)}`)
    }

    return chunks.join('')
  }
}
