import type {
  StreamChunk,
  ToolDefinition,
  ToolResult,
  InferenceHookConfig,
  CrsiConfig,
} from '../shared/index.ts'
import { ProviderRegistry } from '../providers/registry'
import { ContextManager } from './context'
import { PermissionSystem } from './permission'
import type { HookEngine } from './hooks'
import type { ArtifactServer } from '../artifacts/server'
import type { AgentRegistry } from '../agent/agent-registry'
import { analyzeForMemory } from './memory/memory-writer'
import { getMemoryManager } from './memory/memory-loader'
import type { AgentViewManager } from '../agent-view/agent-view-manager'
import type { SkillsLoader } from '../skills/loader'
import { getBackgroundAgentRegistry } from '../agent/background-registry'
import { RulesLoader } from './rules-loader'
import { ExperienceRuleEngine } from './rule-engine.js'
import { PatternAnalyzer } from '../agent/pattern-analyzer.js'
import { EffectivenessTracker } from '../agent/effectiveness-tracker.js'
import { UsageTracker } from './usage-tracker'
import { buildRequest, sendInferenceCheck, isInferenceHookEnabled } from './inference-hook'
import { getFileInboxTransport } from '../agent/cross-session/file-inbox'
import { getMessageBus } from '../agent/message-bus'
import { createT } from '../i18n-core/t'
import enUS from '../i18n-core/locales/en-US.json'
import zhCN from '../i18n-core/locales/zh-CN.json'
import type { TranslationMap } from '../i18n-core/types'

const bundles: Record<string, TranslationMap> = {
  'en-US': enUS as TranslationMap,
  'zh-CN': zhCN as TranslationMap,
}
const t = createT(bundles['en-US'] || (enUS as TranslationMap), enUS as TranslationMap)

export class QueryEngine {
  private hookEngine?: HookEngine
  private artifactServer?: ArtifactServer
  private agentRegistry?: AgentRegistry
  private agentViewManager?: AgentViewManager
  private skillsLoader?: SkillsLoader
  private ruleEngine?: ExperienceRuleEngine
  private _patternAnalyzer?: PatternAnalyzer
  private _effectivenessTracker?: EffectivenessTracker
  private goal?: string
  private maxGoalLoops = 20
  private lastAssistantContent?: string
  /** Custom verification shell script path for goal checking. */
  private goalVerifyScript?: string
  /** Custom verification skill name for goal checking. */
  private goalVerifySkill?: string
  /** Whether to auto-decompose goal into subtasks. */
  private goalDecompose = false
  /** Subtask IDs created via decomposition. */
  private goalSubtasks: string[] = []

  constructor(
    private registry: ProviderRegistry,
    private context: ContextManager,
    private tools: Map<string, ToolDefinition>,
    private permission: PermissionSystem = new PermissionSystem('default'),
    ruleEngine?: ExperienceRuleEngine,
  ) {
    this.ruleEngine = ruleEngine
  }

  /** Session identifier for cross-session messaging. Set by the app startup via setSessionId(). */
  private sessionId: string = 'session-1'

  /** Set the session identifier (called from index.tsx at startup with the actual session name). */
  setSessionId(id: string): void {
    this.sessionId = id
  }

  /** Get the current session identifier. */
  getSessionId(): string {
    return this.sessionId
  }

  /** Poll the cross-session file inbox for messages addressed to this session. */
  async pollCrossSessionInbox(): Promise<void> {
    try {
      const transport = getFileInboxTransport()
      const messages = await transport.poll(this.sessionId)
      if (messages.length > 0) {
        const bus = getMessageBus()
        for (const msg of messages) {
          bus.post(msg.from, msg.to, msg.summary, msg.message, msg.type)
        }
      }
    } catch (err) {
      // Best-effort: don't let a failed inbox poll break the turn
      console.warn('Cross-session inbox poll failed:', err)
    }
  }

  /** Register a hook engine for pre/post tool-use lifecycle events. */
  setHookEngine(hooks: HookEngine): void {
    this.hookEngine = hooks
  }

  /** Register the artifact server for tool context. */
  setArtifactServer(server: ArtifactServer): void {
    this.artifactServer = server
  }

  /** Register the agent registry for custom agent definitions. */
  setAgentRegistry(reg: AgentRegistry): void {
    this.agentRegistry = reg
  }

  /** Get the registered agent registry (may be undefined if not wired). */
  getAgentRegistry(): AgentRegistry | undefined {
    return this.agentRegistry
  }

  /** Register the AgentViewManager for background agent session management. */
  setAgentViewManager(mgr: AgentViewManager): void {
    this.agentViewManager = mgr
  }

  /** Get the AgentViewManager (may be undefined if not wired). */
  getAgentViewManager(): AgentViewManager | undefined {
    return this.agentViewManager
  }

  /** Register the SkillsLoader for Skill tool context injection. */
  setSkillsLoader(loader: SkillsLoader): void {
    this.skillsLoader = loader
  }

  /** Rules loader for path-scoped rules injection. */
  private rulesLoader?: RulesLoader
  /** Files touched in the current turn (for rules matching). */
  private touchedFiles: Set<string> = new Set()
  private usageTracker = new UsageTracker()
  /** Inference hook (DLP) configuration. */
  private inferenceHookConfig?: InferenceHookConfig
  /** CRSI feature flags. */
  private crsiConfig?: Partial<CrsiConfig>

  /** Register the rules loader. */
  setRulesLoader(loader: RulesLoader): void {
    this.rulesLoader = loader
    this.rulesLoader.load()
  }

  /** Register inference hook (DLP) configuration. */
  setInferenceHookConfig(config: InferenceHookConfig): void {
    this.inferenceHookConfig = config
  }

  /** Register CRSI feature flags. */
  setCrsiConfig(config: Partial<CrsiConfig> | undefined): void {
    this.crsiConfig = config
  }

  /** Pending task notifications from background agents (cleared after draining). */
  private pendingTaskNotifications: Array<StreamChunk> = []

  /** Track files touched by tools for rules matching. */
  private trackTouchedFile(toolName: string, params: Record<string, unknown>): void {
    const fileTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep']
    if (!fileTools.includes(toolName)) return
    const filePath = (params.file_path || params.path || params.file) as string | undefined
    if (filePath && typeof filePath === 'string') {
      this.touchedFiles.add(filePath)
    }
  }

  /** Inject matching rules as context after tool execution. */
  private injectRules(): void {
    if (!this.rulesLoader || this.touchedFiles.size === 0) return
    const files = Array.from(this.touchedFiles)
    const block = this.rulesLoader.buildContextBlock(files)
    if (!block) return
    this.context.addMessage({ role: 'user', content: block })
    this.touchedFiles.clear()
  }

  /**
   * Drain pending background task notifications.
   * Call this after tool execution to surface completed/failed background agent results.
   * Returns an array of StreamChunks that can be yielded in a generator.
   */
  drainTaskNotifications(): StreamChunk[] {
    const bgRegistry = getBackgroundAgentRegistry()
    const tasks = bgRegistry.list()
    const chunks: StreamChunk[] = []

    for (const task of tasks) {
      if (task.status === 'running') continue

      // Check if we've already notified for this task
      const alreadyNotified = this.pendingTaskNotifications.some(
        (n) => n.taskNotification?.taskId === task.id,
      )
      if (alreadyNotified) continue

      const chunk: StreamChunk = {
        type: 'task_notification',
        taskNotification: {
          taskId: task.id,
          status: task.status as 'completed' | 'failed',
          description: task.description,
          content: task.result,
          error: task.error,
        },
      }

      this.pendingTaskNotifications.push(chunk)
      chunks.push(chunk)
    }

    return chunks
  }

  /** Set the session goal for goal-driven execution. */
  setGoal(
    goal: string,
    opts?: { verifyScript?: string; verifySkill?: string; decompose?: boolean },
  ): void {
    this.goal = goal
    this.goalVerifyScript = opts?.verifyScript
    this.goalVerifySkill = opts?.verifySkill
    this.goalDecompose = opts?.decompose ?? false
    this.goalSubtasks = []
  }

  /** Get current goal state for status display. */
  getGoalState(): {
    goal?: string
    verifyScript?: string
    verifySkill?: string
    decompose: boolean
    subtasks: string[]
  } {
    return {
      goal: this.goal,
      verifyScript: this.goalVerifyScript,
      verifySkill: this.goalVerifySkill,
      decompose: this.goalDecompose,
      subtasks: this.goalSubtasks,
    }
  }

  /** Register subtasks created via decomposition. */
  addGoalSubtask(taskId: string): void {
    this.goalSubtasks.push(taskId)
  }

  /** Get the last assistant text content. */
  getLastAssistantContent(): string | undefined {
    return this.lastAssistantContent
  }

  /** Wire LLM-based conversation summarization into the context manager. */
  setupContextSummarizer(): void {
    this.context.setSummarizer(async (messages, heading) => {
      const text = messages
        .map((m) => {
          const role = m.role
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          return `[${role}]: ${content.slice(0, 2000)}`
        })
        .join('\n')

      // Build a minimal system prompt for summarization
      const summaryPrompt = `You are a conversation summarizer. Create a concise summary (1-3 paragraphs) of this conversation excerpt. Focus on: key topics discussed, decisions made, code changes mentioned, and open questions. Heading: ${heading}`

      // Collect full summary text from streaming response
      let summary = ''
      try {
        for await (const chunk of this.registry.chat({
          model: this.registry.getActiveModel(),
          messages: [
            { role: 'system', content: summaryPrompt },
            { role: 'user', content: text },
          ],
          maxTokens: 2000,
        })) {
          if (chunk.type === 'text' && chunk.content) {
            summary += chunk.content
          }
          if (chunk.type === 'stop') break
          if (chunk.type === 'error') break
        }
      } catch {
        // Return a minimal summary on failure
      }

      return summary.slice(0, 8000) || t('system.context.omitted')
    })
  }

  getPermission(): PermissionSystem {
    return this.permission
  }

  getUsageTracker(): UsageTracker {
    return this.usageTracker
  }

  async *process(userInput: string, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    // Poll for cross-session messages before each turn
    await this.pollCrossSessionInbox()

    // Fire UserPromptSubmit hooks before processing
    if (this.hookEngine) {
      const submitResult = await this.hookEngine.executeUserPromptSubmit(userInput, this.sessionId)
      if (submitResult.additionalContext) {
        this.context.addMessage({
          role: 'user',
          content: `[Hook context]: ${submitResult.additionalContext}`,
        })
      }
      if (!submitResult.allowed) {
        yield {
          type: 'error',
          error: submitResult.reason || t('errors.user_input_blocked'),
        }
        return
      }
    }

    // Add user message to context
    this.context.addMessage({ role: 'user', content: userInput })

    // Check compaction before processing
    if (this.context.needsCompaction()) {
      await this.compactWithHooks('conversation summary')
    }

    const systemPrompt = this.context.getSystemPrompt()
    const messages = this.context.getMessages()
    const toolDefs = this.getToolDefinitions()

    // ── PreInference DLP checkpoint ──
    if (isInferenceHookEnabled(this.inferenceHookConfig)) {
      const hookConfig = this.inferenceHookConfig!
      const provider = this.registry.getActive().config.id
      const model = this.registry.getActiveModel()
      const request = buildRequest(
        messages,
        this.sessionId,
        provider,
        model,
        hookConfig.organization_id,
      )
      const verdict = await sendInferenceCheck(hookConfig, request)
      if (!verdict.allowed) {
        yield {
          type: 'error',
          error: verdict.reason || t('errors.dlp_blocked'),
        }
        return
      }
    }

    let assistantContent = ''
    let reasoningContent = ''
    let thinkingContent = ''
    let turnApiInputTokens = 0
    let turnApiOutputTokens = 0
    const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []

    // Stream model response
    try {
      for await (const chunk of this.registry.chat({
        model: this.registry.getActiveModel(),
        messages,
        systemPrompt,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        signal,
      })) {
        yield chunk

        if (chunk.type === 'error') {
          this.context.addMessage({
            role: 'assistant',
            content: t('errors.model_error', { error: chunk.error ?? 'Unknown error' }),
          })
          return
        }

        if (chunk.type === 'text' && chunk.content) {
          assistantContent += chunk.content
        }

        if (chunk.reasoning_content) {
          reasoningContent += chunk.reasoning_content
        }

        if (chunk.type === 'thinking' && chunk.thinking) {
          thinkingContent += chunk.thinking
        }

        if (chunk.type === 'tool_use' && chunk.toolUse) {
          toolUses.push({
            id: chunk.toolUse.id,
            name: chunk.toolUse.name,
            input: chunk.toolUse.input,
          })
        }

        if (chunk.type === 'usage' && chunk.inputTokens !== undefined) {
          // Accumulate API-reported token counts for this turn
          turnApiInputTokens += chunk.inputTokens
          turnApiOutputTokens += chunk.outputTokens || 0
        }

        if (chunk.type === 'stop') {
          // Add assistant response to context
          if (assistantContent || reasoningContent || thinkingContent) {
            const contentBlocks: import('../shared/types').ContentBlock[] = []
            if (thinkingContent) {
              contentBlocks.push({ type: 'thinking', thinking: thinkingContent })
            }
            if (assistantContent) {
              contentBlocks.push({ type: 'text', text: assistantContent })
            }
            const msg: import('../shared/types').Message = {
              role: 'assistant',
              content: thinkingContent ? contentBlocks : assistantContent || '',
            }
            if (reasoningContent) msg.reasoning_content = reasoningContent
            this.context.addMessage(msg)
          }
        }
      }
    } catch (err) {
      if (isAbortError(err)) {
        // User interrupted — keep partial content, stop gracefully
        if (assistantContent || reasoningContent || thinkingContent) {
          const contentBlocks: import('../shared/types').ContentBlock[] = []
          if (thinkingContent) {
            contentBlocks.push({ type: 'thinking', thinking: thinkingContent })
          }
          if (assistantContent) {
            contentBlocks.push({ type: 'text', text: assistantContent })
          }
          const msg: import('../shared/types').Message = {
            role: 'assistant',
            content: thinkingContent ? contentBlocks : assistantContent || '',
          }
          if (reasoningContent) msg.reasoning_content = reasoningContent
          this.context.addMessage(msg)
        }
        yield { type: 'stop' }
        return
      }
      yield { type: 'error', error: String(err) }
      return
    }

    // Track last assistant content for goal checking
    if (assistantContent) {
      this.lastAssistantContent = assistantContent
    }

    // Analyze user message for memory-worthy content after AI response
    if (assistantContent && userInput) {
      try {
        analyzeForMemory(userInput, getMemoryManager())
      } catch {
        // memory analysis is non-critical
      }
    }

    // Execute any tools that were requested
    for (const toolUse of toolUses) {
      const result = await this.executeTool(toolUse.name, toolUse.input)
      yield {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.success ? result.content : result.error || result.content,
      }

      // Add tool use + result to context
      // DeepSeek V4 thinking mode requires reasoning_content on every assistant message
      this.context.addMessage({
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input }],
        reasoning_content: '',
      })
      this.context.addMessage({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: result.success ? result.content : result.error || result.content,
          },
        ],
      })
    }

    // Record API token usage for this turn, attributed to executed tools
    if (turnApiInputTokens > 0 || turnApiOutputTokens > 0) {
      if (toolUses.length > 0) {
        // Attribute tokens equally across all tools invoked this turn
        const perTool = toolUses.length
        for (const tu of toolUses) {
          this.usageTracker.recordApiUsage(
            Math.round(turnApiInputTokens / perTool),
            Math.round(turnApiOutputTokens / perTool),
            tu.name,
          )
        }
      } else {
        this.usageTracker.recordApiUsage(turnApiInputTokens, turnApiOutputTokens, 'chat')
      }
    } else {
      // Fallback: API doesn't report usage — use char-based estimate
      const estimated = Math.round((assistantContent.length + userInput.length) / 4)
      if (toolUses.length > 0) {
        for (const tu of toolUses) {
          this.usageTracker.recordEstimatedUsage(Math.round(estimated / toolUses.length), tu.name)
        }
      }
    }

    // Inject path-scoped rules for touched files
    this.injectRules()

    // Drain task notifications after tool execution
    for (const chunk of this.drainTaskNotifications()) {
      yield chunk
    }

    // If tools were executed, recursively continue the conversation
    if (toolUses.length > 0) {
      yield* this.continueWithTools(signal)
      return
    }

    // Fire Stop hooks when AI finishes with no tool calls
    yield* this.checkStopHook(signal)

    // Final drain of task notifications
    for (const chunk of this.drainTaskNotifications()) {
      yield chunk
    }
  }

  async *processWithGoal(input: string, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    let loop = 0
    while (loop < this.maxGoalLoops) {
      yield* this.process(input, signal)
      loop++

      if (!this.goal) break

      // Build verification prompt based on mode
      const checkMsg = this.buildGoalCheckMessage()

      // If using script verification, run the script instead of asking AI
      if (this.goalVerifyScript) {
        const passed = await this.runScriptVerification()
        if (passed) {
          yield {
            type: 'text',
            content: t('system.goal.verified', { script: this.goalVerifyScript }),
          }
          break
        }
        // Script failed — continue looping
        yield {
          type: 'text',
          content: t('system.goal.failed_continuing', { loop: String(loop) }),
        }
        continue
      }

      // If using skill verification, delegate to the skill
      if (this.goalVerifySkill) {
        yield {
          type: 'text',
          content: t('system.goal.running_skill', { skill: this.goalVerifySkill }),
        }
        yield* this.process(checkMsg, signal)
        if (this.lastAssistantContent?.includes('VERIFIED')) break
        continue
      }

      // Default: ask AI YES/NO
      yield* this.process(checkMsg, signal)
      if (this.lastAssistantContent?.includes('YES')) break
    }

    if (loop >= this.maxGoalLoops) {
      yield {
        type: 'text',
        content: t('system.goal.max_loops', { max: String(this.maxGoalLoops) }),
      }
    }
  }

  /** Build the goal verification prompt. */
  private buildGoalCheckMessage(): string {
    if (this.goalVerifyScript) {
      return `Run the verification script "${this.goalVerifyScript}" to check: ${this.goal}`
    }
    if (this.goalVerifySkill) {
      return `Use the skill "${this.goalVerifySkill}" to verify: ${this.goal}. If the goal is achieved, respond with VERIFIED. Otherwise explain what's missing.`
    }
    return `Has this goal been achieved? "${this.goal}" Answer YES or NO with reason.`
  }

  /** Run a shell script for goal verification. */
  private async runScriptVerification(): Promise<boolean> {
    if (!this.goalVerifyScript) return false
    try {
      const { spawnSync } = await import('node:child_process')
      const { resolveSafe } = await import('../security/path')
      // Validate the script path is within the workspace before execution
      const safePath = resolveSafe(process.cwd(), this.goalVerifyScript)
      const result = spawnSync(safePath, [], { timeout: 30000, stdio: 'pipe' })
      return result.status === 0 // exit code 0 = success
    } catch {
      return false // non-zero exit or path rejection = not yet achieved
    }
  }

  private async *continueWithTools(signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const MAX_TURNS = 20
    const toolDefs = this.getToolDefinitions()

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const systemPrompt = this.context.getSystemPrompt()
      const messages = this.context.getMessages()

      // ── PreInference DLP checkpoint (every tool-calling turn) ──
      if (isInferenceHookEnabled(this.inferenceHookConfig)) {
        const hookConfig = this.inferenceHookConfig!
        const provider = this.registry.getActive().config.id
        const model = this.registry.getActiveModel()
        const request = buildRequest(
          messages,
          this.sessionId,
          provider,
          model,
          hookConfig.organization_id,
        )
        const verdict = await sendInferenceCheck(hookConfig, request)
        if (!verdict.allowed) {
          yield {
            type: 'error',
            error: verdict.reason || t('errors.dlp_blocked'),
          }
          return
        }
      }

      let assistantContent = ''
      let reasoningContent = ''
      let thinkingContent = ''
      const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []

      try {
        for await (const chunk of this.registry.chat({
          model: this.registry.getActiveModel(),
          messages,
          systemPrompt,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          signal,
        })) {
          yield chunk

          if (chunk.type === 'error') return
          if (chunk.type === 'text' && chunk.content) assistantContent += chunk.content

          if (chunk.reasoning_content) {
            reasoningContent += chunk.reasoning_content
          }

          if (chunk.type === 'thinking' && chunk.thinking) {
            thinkingContent += chunk.thinking
          }

          if (chunk.type === 'tool_use' && chunk.toolUse) {
            toolUses.push({
              id: chunk.toolUse.id,
              name: chunk.toolUse.name,
              input: chunk.toolUse.input,
            })
          }
        }
      } catch (err) {
        if (isAbortError(err)) {
          if (assistantContent || reasoningContent || thinkingContent) {
            const contentBlocks: import('../shared/types').ContentBlock[] = []
            if (thinkingContent) {
              contentBlocks.push({ type: 'thinking', thinking: thinkingContent })
            }
            if (assistantContent) {
              contentBlocks.push({ type: 'text', text: assistantContent })
            }
            const msg: import('../shared/types').Message = {
              role: 'assistant',
              content: thinkingContent ? contentBlocks : assistantContent || '',
            }
            if (reasoningContent) msg.reasoning_content = reasoningContent
            this.context.addMessage(msg)
          }
          yield { type: 'stop' }
          return
        }
        yield { type: 'error', error: String(err) }
        return
      }

      if (assistantContent || reasoningContent || thinkingContent) {
        const contentBlocks: import('../shared/types').ContentBlock[] = []
        if (thinkingContent) {
          contentBlocks.push({ type: 'thinking', thinking: thinkingContent })
        }
        if (assistantContent) {
          contentBlocks.push({ type: 'text', text: assistantContent })
        }
        const msg: import('../shared/types').Message = {
          role: 'assistant',
          content: thinkingContent ? contentBlocks : assistantContent || '',
        }
        if (reasoningContent) msg.reasoning_content = reasoningContent
        this.context.addMessage(msg)
      }

      // Safety: when max turns reached with pending tools, ask model to summarize
      if (turn === MAX_TURNS - 1 && toolUses.length > 0) {
        this.context.addMessage({
          role: 'user',
          content: t('errors.max_tool_turns_warning', {
            max: String(MAX_TURNS),
            pending: String(toolUses.length),
          }),
        })
        // Give model one final chance to respond with a summary
        try {
          const finalSystemPrompt = this.context.getSystemPrompt()
          const finalMessages = this.context.getMessages()
          for await (const chunk of this.registry.chat({
            model: this.registry.getActiveModel(),
            messages: finalMessages,
            systemPrompt: finalSystemPrompt,
            tools: undefined, // no tools — force text-only summary
            signal,
          })) {
            yield chunk
            if (chunk.type === 'error') return
          }
        } catch {
          yield {
            type: 'error',
            error: t('errors.max_tool_turns', { max: String(MAX_TURNS) }),
          }
        }
        return
      }

      // No more tool calls — fire Stop hook and potentially continue
      if (toolUses.length === 0) {
        yield* this.checkStopHook(signal)
        return
      }

      // Execute tools and feed results back to the model for the next turn
      for (const toolUse of toolUses) {
        const result = await this.executeTool(toolUse.name, toolUse.input)
        yield {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.content,
        }

        // DeepSeek V4 thinking mode requires reasoning_content on every assistant message
        this.context.addMessage({
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input }],
          reasoning_content: '',
        })
        this.context.addMessage({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: result.success ? result.content : result.error || result.content,
            },
          ],
        })
      }
    }
    // Max turns reached — safety limit, stop gracefully
  }

  private async executeTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { success: false, content: '', error: `Unknown tool: ${name}` }
    }

    // Security: check permission before executing
    if (this.permission.needsApproval(tool, params)) {
      return {
        success: false,
        content: '',
        error: t('errors.tool_not_allowed', { name }),
      }
    }

    // Run PreToolUse hooks
    let effectiveParams = params
    let hookWarnings: string[] = []
    if (this.hookEngine) {
      const preResult = await this.hookEngine.executePreToolUse(name, params, this.sessionId)
      if (!preResult.allowed) {
        return {
          success: false,
          content: '',
          error: preResult.reason || t('errors.tool_blocked', { name }),
        }
      }
      if (preResult.modifiedInput) {
        effectiveParams = { ...params, ...preResult.modifiedInput }
      }
    }

    // CRSI RuleEngine intercept — gated by crsi.preToolHook feature flag
    if (this.crsiConfig?.preToolHook !== false && this.ruleEngine) {
      const ruleResult = this.ruleEngine.intercept(name, effectiveParams)
      if (Object.keys(ruleResult.modified).length > 0) {
        effectiveParams = ruleResult.modified
      }
      if (ruleResult.warnings.length > 0) {
        hookWarnings = ruleResult.warnings
      }
    }

    try {
      const result = await tool.execute(effectiveParams, {
        cwd: process.cwd(),
        sessionId: this.sessionId,
        provider: this.registry.getActive().config.id,
        model: this.registry.getActiveModel(),
        skillsLoader: this.skillsLoader,
        registry: this.registry,
        toolRegistry: this.tools,
        artifactServer: this.artifactServer,
        agentRegistry: this.agentRegistry,
        backgroundAgentRegistry: getBackgroundAgentRegistry(),
        permissionSystem: this.permission,
        ruleEngine: this.ruleEngine,
      })

      // Track touched files for rules matching
      this.trackTouchedFile(name, effectiveParams)

      // Prepend CRSI warnings to result content
      if (hookWarnings.length > 0 && result.success) {
        result.content = hookWarnings.join('\n') + '\n' + (result.content || '')
      }

      // Run PostToolUse hooks
      if (this.hookEngine) {
        await this.hookEngine.executePostToolUse(name, effectiveParams, result, this.sessionId)
      }

      return result
    } catch (err) {
      // Sanitize error: strip stack traces and internal paths to prevent
      // information disclosure to the LLM conversation context.
      const message =
        err instanceof Error ? err.message : String(err).split('\n')[0] || 'Unknown error'
      return { success: false, content: '', error: `Tool execution failed: ${message}` }
    }
  }

  private getToolDefinitions(): Record<string, unknown>[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      input_schema: t.parameters, // Anthropic-style naming
    }))
  }

  getContext(): ContextManager {
    return this.context
  }

  getRegistry(): ProviderRegistry {
    return this.registry
  }

  getTools(): Map<string, ToolDefinition> {
    return this.tools
  }

  getRuleEngine(): ExperienceRuleEngine | undefined {
    return this.ruleEngine
  }

  /** Lazily-initialized PatternAnalyzer singleton. */
  getPatternAnalyzer(): PatternAnalyzer {
    if (!this._patternAnalyzer) {
      this._patternAnalyzer = new PatternAnalyzer()
    }
    return this._patternAnalyzer
  }

  /** Lazily-initialized EffectivenessTracker singleton. */
  getEffectivenessTracker(): EffectivenessTracker {
    if (!this._effectivenessTracker) {
      this._effectivenessTracker = new EffectivenessTracker()
      this._effectivenessTracker.load()
    }
    return this._effectivenessTracker
  }

  /** Register a tool dynamically (used by MCP auto-registration). */
  registerTool(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      process.stderr.write(t('errors.tool_collision', { name: tool.name }) + '\n')
      return
    }
    this.tools.set(tool.name, tool)
  }

  /** Remove a dynamically registered tool by name. */
  unregisterTool(name: string): void {
    this.tools.delete(name)
  }

  /** Register multiple tools at once. */
  registerTools(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool)
    }
  }

  switchProvider(providerId: string, modelId?: string): void {
    this.registry.switchProvider(providerId, modelId)
    // Update context manager's max tokens to match the new model's context window
    if (modelId) {
      const model = this.registry.findModel(modelId)
      if (model) {
        const DISABLE_1M = process.env.MIPHAM_DISABLE_1M_CONTEXT === '1'
        const maxTokens =
          DISABLE_1M && model.contextWindow > 200_000 ? 200_000 : model.contextWindow
        this.context.updateMaxTokens(maxTokens)
      }
    }
  }

  /** Wrap context compaction with PreCompact/PostCompact hooks. */
  private async compactWithHooks(heading: string): Promise<void> {
    if (this.hookEngine) {
      const preResult = await this.hookEngine.executePreCompact(this.sessionId)
      if (preResult.additionalContext) {
        this.context.addMessage({
          role: 'user',
          content: `[Pre-compact context]: ${preResult.additionalContext}`,
        })
      }
    }

    await this.context.compact(heading)

    if (this.hookEngine) {
      const postResult = await this.hookEngine.executePostCompact(this.sessionId)
      if (postResult.additionalContext) {
        this.context.addMessage({
          role: 'user',
          content: `[Post-compact context]: ${postResult.additionalContext}`,
        })
      }
    }
  }

  /** Fire Stop hook. If blocked, feed the reason back to the AI and continue. */
  private async *checkStopHook(signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    if (!this.hookEngine) return

    const stopResult = await this.hookEngine.executeStop(this.sessionId)
    if (stopResult.decision === 'block') {
      // Feed the block reason back to the AI and continue
      this.context.addMessage({
        role: 'user',
        content: t('system.context.stop_blocked', {
          reason: stopResult.reason || 'Continue working.',
        }),
      })
      yield* this.continueWithTools(signal)
    }
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true
  if (
    typeof DOMException !== 'undefined' &&
    err instanceof DOMException &&
    err.name === 'AbortError'
  )
    return true
  return false
}
