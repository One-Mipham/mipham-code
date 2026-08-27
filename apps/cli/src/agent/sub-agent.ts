import type { ProviderRegistry } from '../providers/registry'
import type { Llm } from '../providers/llm'
import type { ToolDefinition } from '../shared/index.ts'
import type { SubAgentType, SubAgentOptions, AgentDefinition } from './types'
import { createAgentContext } from './agent-context'
import { getBackgroundAgentRegistry } from './background-registry'
import { getMessageBus } from './message-bus'
import type { HookEngine } from '../core/hooks'
import type { PermissionSystem } from '../core/permission'
import { AgentExperience } from './agent-experience'
import { PatternAnalyzer } from './pattern-analyzer.js'
import { getWorkspaceTrust } from '../core/workspace-trust'
import type { ExperienceRuleEngine } from '../core/rule-engine.js'

// Singleton instances (created lazily)
let _patternAnalyzer: PatternAnalyzer | undefined

function getPatternAnalyzer(): PatternAnalyzer {
  if (!_patternAnalyzer) _patternAnalyzer = new PatternAnalyzer()
  return _patternAnalyzer
}

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
    private ruleEngine?: ExperienceRuleEngine,
    private llm?: Llm,
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
        // Auto-log agent experience for background tasks
        if (task.status === 'completed') {
          this.logSuccessExperience(agentType, description, task.result || '', options.agentDef)
        } else {
          this.logFailureExperience(
            agentType,
            description,
            task.error || 'Unknown error',
            options.agentDef,
          )
        }

        // CRSI: trigger pattern analysis after each agent execution
        // Gated by crsi.autoPatternAnalysis feature flag
        if (options.autoPatternAnalysis !== false) {
          try {
            const analyzer = getPatternAnalyzer()
            const agentName = options.agentDef?.name || agentType
            const patterns = analyzer.analyzeAgent(agentName)
            if (patterns.length > 0 && this.ruleEngine) {
              for (const pattern of patterns) {
                const toolRule = analyzer.toToolRule(pattern)
                this.ruleEngine.register(toolRule)
              }
            }
          } catch {
            // Pattern analysis failure never blocks agent execution
          }
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
      this.logSuccessExperience(agentType, description, result, options.agentDef)

      // CRSI: trigger pattern analysis after successful sync execution
      // Gated by crsi.autoPatternAnalysis feature flag
      if (options.autoPatternAnalysis !== false) {
        try {
          const analyzer = getPatternAnalyzer()
          const agentName = options.agentDef?.name || agentType
          const patterns = analyzer.analyzeAgent(agentName)
          if (patterns.length > 0 && this.ruleEngine) {
            for (const pattern of patterns) {
              const toolRule = analyzer.toToolRule(pattern)
              this.ruleEngine.register(toolRule)
            }
          }
        } catch {
          // Pattern analysis failure never blocks agent execution
        }
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
      this.logFailureExperience(agentType, description, String(err), options.agentDef)

      // CRSI: trigger pattern analysis after failed sync execution (failures produce patterns too)
      // Gated by crsi.autoPatternAnalysis feature flag
      if (options.autoPatternAnalysis !== false) {
        try {
          const analyzer = getPatternAnalyzer()
          const agentName = options.agentDef?.name || agentType
          const patterns = analyzer.analyzeAgent(agentName)
          if (patterns.length > 0 && this.ruleEngine) {
            for (const pattern of patterns) {
              const toolRule = analyzer.toToolRule(pattern)
              this.ruleEngine.register(toolRule)
            }
          }
        } catch {
          // Pattern analysis failure never blocks agent execution
        }
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
    if (!this.registry.getActive()) {
      throw new Error('No active provider available for sub-agent execution')
    }

    const model = this.registry.getActiveModel()
    const agentType = options.type || 'general'
    const agentDef = options.agentDef

    // ── P0-3: Create isolated PermissionSystem for this sub-agent ──
    // The agent definition's permissionMode is clamped against parent's org
    // restrictions (maxAllowedMode, forbiddenModes). When permissionMode is
    // 'inherit' or not set, the parent's mode is used but still clamped.
    let subPermission = this.permission // default: use parent's
    if (this.permission) {
      const agentPermMode =
        agentDef?.permissionMode && agentDef.permissionMode !== 'inherit'
          ? agentDef.permissionMode
          : 'inherit'
      subPermission = this.permission.createSubAgentPermission(agentPermMode)
    }

    // Resolve execution directory: worktree isolation or process cwd
    const execCwd = options.worktreePath || process.cwd()

    // Check workspace trust for the execution directory.
    // For worktree-isolated agents, auto-trust the worktree if the parent is trusted.
    if (options.worktreePath) {
      const trust = getWorkspaceTrust()
      if (!trust.isTrusted(execCwd)) {
        // Auto-trust worktree directories when the parent workspace is trusted
        if (trust.isTrusted(process.cwd())) {
          trust.trust(execCwd)
        }
        // Otherwise, proceed with a warning — don't block agent execution
      }

      // P0-4: Auto-disallow Git tool for worktree-isolated sub-agents
      // to prevent destructive operations on the main checkout.
      // Agent definitions can explicitly re-enable Git if needed.
      if (!agentDef?.tools) {
        // No explicit allowlist — add Git to disallowedTools
        const existingDisallowed = agentDef?.disallowedTools
          ? agentDef.disallowedTools
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : []
        if (!existingDisallowed.includes('Git')) {
          existingDisallowed.push('Git')
        }
        if (agentDef) {
          agentDef.disallowedTools = existingDisallowed.join(',')
        }
      }
    }

    // Resolve system prompt: agentDef > options.systemPrompt > builtin type
    const systemPrompt =
      agentDef?.systemPrompt || options.systemPrompt || TYPE_SYSTEM_PROMPTS[agentType]

    // Resolve the sub-agent's model first, so its context window is known
    // before the isolated context is created (model-aware sizing).
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
        bus.post(
          'system',
          'main',
          `Sub-agent model fallback: ${resolvedModel} → ${model}`,
          warnMsg,
          'warning',
        )

        finalModel = model
      }
    }

    // Create isolated context with tool scoping, sized to the resolved model.
    const resolvedDef: AgentDefinition = agentDef || {
      name: agentType,
      description: '',
      systemPrompt,
      model: options.modelOverride || 'inherit',
      permissionMode: 'inherit',
      background: false,
      source: 'builtin',
    }
    const contextWindow = this.registry.findModel(finalModel)?.contextWindow
    const { context, allowedTools } = createAgentContext(
      resolvedDef,
      this.toolRegistry,
      contextWindow,
    )

    context.setSystemPrompt(systemPrompt)

    // Seed inherited parent conversation (fork inheritance) as a byte-identical
    // prefix so the provider prompt cache is reused.
    if (options.inheritContext && options.inheritContext.messages.length > 0) {
      context.seedMessages(options.inheritContext.messages)
    }

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

    const chunks: string[] = []
    const MAX_TOOL_TURNS = options.maxTurns || 5
    let hitMaxTurns = false

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

        for await (const chunk of (this.llm ?? this.registry).chat({
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
            throw new Error(`Sub-agent execution failed (model ${finalModel}): ${chunk.error}`)
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

          // ── P0-5: Run PreToolUse hooks (before permission check) ──
          let effectiveInput = tu.input
          if (this.hookEngine) {
            const preResult = await this.hookEngine.executePreToolUse(
              tu.name,
              tu.input,
              'sub-agent',
            )
            if (!preResult.allowed) {
              const denialMsg = preResult.reason
                ? `Tool "${tu.name}" blocked by PreToolUse hook: ${preResult.reason}`
                : `Tool "${tu.name}" blocked by PreToolUse hook.`
              currentMessages.push({
                role: 'user' as const,
                content: denialMsg,
              })
              continue
            }
            // Apply modified input from hooks
            if (preResult.modifiedInput) {
              effectiveInput = { ...tu.input, ...preResult.modifiedInput }
            }
          }

          // Security: check permission before executing.
          // Sub-agents run without user interaction — tools requiring approval are rejected.
          // When permission system is absent (undefined), allow all tools (backward compat
          // for tests and headless usage). When present, always enforce approval checks.
          // P0-3: Uses isolated subPermission (clamped by org restrictions) instead of parent's.
          if (subPermission?.needsApproval(tool, effectiveInput)) {
            currentMessages.push({
              role: 'user' as const,
              content:
                `Tool "${tu.name}" requires user approval (permission: ask). ` +
                `Cannot execute in non-interactive sub-agent context.`,
            })
            continue
          }

          try {
            const result = await tool.execute(effectiveInput, {
              cwd: execCwd,
              sessionId: 'sub-agent',
              provider: '',
              model: finalModel,
            })

            // ── P0-5: Run PostToolUse hooks ──
            let displayResult = result
            if (this.hookEngine) {
              const postResult = await this.hookEngine.executePostToolUse(
                tu.name,
                effectiveInput,
                result,
                'sub-agent',
              )
              if (postResult.updatedOutput) {
                displayResult = { ...result, content: postResult.updatedOutput }
              }
              if (postResult.additionalContext) {
                displayResult = {
                  ...displayResult,
                  content: displayResult.content
                    ? displayResult.content + '\n' + postResult.additionalContext
                    : postResult.additionalContext,
                }
              }
            }

            currentMessages.push({
              role: 'assistant' as const,
              content: [
                { type: 'tool_use' as const, id: tu.id, name: tu.name, input: effectiveInput },
              ],
            })
            currentMessages.push({
              role: 'user' as const,
              content: [
                {
                  type: 'tool_result' as const,
                  tool_use_id: tu.id,
                  content: displayResult.success
                    ? displayResult.content
                    : displayResult.error || displayResult.content,
                },
              ],
            })
          } catch (err) {
            // ── P0-5: Run PostToolUseFailure hooks ──
            if (this.hookEngine) {
              this.hookEngine
                .executePostToolUseFailure(tu.name, effectiveInput, String(err), 'sub-agent')
                .catch(() => {
                  // Hook failures never block execution
                })
            }

            currentMessages.push({
              role: 'user' as const,
              content: `Tool "${tu.name}" execution error: ${String(err)}`,
            })
          }
        }

        // Don't send system prompt on subsequent turns
        currentSystemPrompt = ''

        // On the final permitted turn we still used tools → hit the cap.
        if (turn === MAX_TOOL_TURNS - 1) hitMaxTurns = true
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err
      }
      if (err instanceof Error && err.message.startsWith('Sub-agent')) {
        throw err
      }
      throw new Error(`Sub-agent execution failed (model ${finalModel}): ${String(err)}`)
    }

    const result = chunks.join('')
    if (hitMaxTurns) {
      return (
        `[partial result — sub-agent reached its ${MAX_TOOL_TURNS}-turn limit; ` +
        'task may be incomplete. Use SendMessage to continue this sub-agent.]\n\n' +
        result
      )
    }
    return result
  }

  /**
   * Log a successful execution to AgentExperience.
   * Wrapped in try/catch so it never breaks agent execution.
   */
  private logSuccessExperience(
    agentType: SubAgentType,
    description: string,
    result: string,
    agentDef?: AgentDefinition,
  ): void {
    try {
      const name = agentDef?.name || agentType
      const exp = new AgentExperience(name)
      if (result && result.trim()) {
        const firstLine = result.trim().split('\n')[0]?.slice(0, 150) || 'Task completed'
        exp.logSuccess(firstLine, description)
      }
    } catch {
      // Never let experience logging break execution
    }
  }

  /**
   * Log a failed execution to AgentExperience.
   * Wrapped in try/catch so it never breaks agent execution.
   */
  private logFailureExperience(
    agentType: SubAgentType,
    description: string,
    errMsg: string,
    agentDef?: AgentDefinition,
  ): void {
    try {
      const name = agentDef?.name || agentType
      const exp = new AgentExperience(name)
      const truncated = errMsg.slice(0, 200)
      exp.logFailure(truncated, description)
    } catch {
      // Never let experience logging break execution
    }
  }
}
