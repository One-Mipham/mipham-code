import type { Message, StreamChunk, ToolDefinition, ToolResult } from '../shared/index.ts'
import { ProviderRegistry } from '../providers/registry'
import { ContextManager } from './context'
import { PermissionSystem } from './permission'
import type { HookEngine } from './hooks'

export class QueryEngine {
  private hookEngine?: HookEngine

  constructor(
    private registry: ProviderRegistry,
    private context: ContextManager,
    private tools: Map<string, ToolDefinition>,
    private permission: PermissionSystem = new PermissionSystem('bypass'),
  ) {}

  /** Register a hook engine for pre/post tool-use lifecycle events. */
  setHookEngine(hooks: HookEngine): void {
    this.hookEngine = hooks
  }

  /** Wire LLM-based conversation summarization into the context manager. */
  setupContextSummarizer(): void {
    this.context.setSummarizer(async (messages, heading) => {
      const text = messages
        .map((m) => {
          const role = m.role
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
          return `[${role}]: ${content.slice(0, 500)}`
        })
        .join('\n')

      // Build a minimal system prompt for summarization
      const summaryPrompt =
        `You are a conversation summarizer. Create a concise summary (1-3 paragraphs) of this conversation excerpt. Focus on: key topics discussed, decisions made, code changes mentioned, and open questions. Heading: ${heading}`

      // Collect full summary text from streaming response
      let summary = ''
      try {
        for await (const chunk of this.registry.chat({
          model: this.registry.getActiveModel(),
          messages: [
            { role: 'system', content: summaryPrompt },
            { role: 'user', content: text },
          ],
          maxTokens: 300,
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

      return summary.slice(0, 2000) || 'Prior conversation context omitted.'
    })
  }

  getPermission(): PermissionSystem {
    return this.permission
  }

  async *process(userInput: string, signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    // Add user message to context
    this.context.addMessage({ role: 'user', content: userInput })

    // Check compaction before processing
    if (this.context.needsCompaction()) {
      await this.context.compact('conversation summary')
    }

    const systemPrompt = this.context.getSystemPrompt()
    const messages = this.context.getMessages()
    const toolDefs = this.getToolDefinitions()

    let assistantContent = ''
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
        this.context.addMessage({ role: 'assistant', content: `Error: ${chunk.error}` })
        return
      }

      if (chunk.type === 'text' && chunk.content) {
        assistantContent += chunk.content
      }

      if (chunk.type === 'tool_use' && chunk.toolUse) {
        toolUses.push({
          id: chunk.toolUse.id,
          name: chunk.toolUse.name,
          input: chunk.toolUse.input,
        })
      }

      if (chunk.type === 'stop') {
        // Add assistant response to context
        if (assistantContent) {
          this.context.addMessage({ role: 'assistant', content: assistantContent })
        }
      }
    }
    } catch (err) {
      if (isAbortError(err)) {
        // User interrupted — keep partial content, stop gracefully
        if (assistantContent) {
          this.context.addMessage({ role: 'assistant', content: assistantContent })
        }
        yield { type: 'stop' }
        return
      }
      yield { type: 'error', error: String(err) }
      return
    }

    // Execute any tools that were requested
    for (const toolUse of toolUses) {
      const result = await this.executeTool(toolUse.name, toolUse.input)
      yield {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.success ? result.content : (result.error || result.content),
      }

      // Add tool use + result to context
      this.context.addMessage({
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input }],
      })
      this.context.addMessage({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: result.content }],
      })
    }

    // If tools were executed, recursively continue the conversation
    if (toolUses.length > 0) {
      yield* this.continueWithTools(signal)
    }
  }

  private async *continueWithTools(signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const MAX_TURNS = 10
    const toolDefs = this.getToolDefinitions()

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const systemPrompt = this.context.getSystemPrompt()
      const messages = this.context.getMessages()

      let assistantContent = ''
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
          if (assistantContent) {
            this.context.addMessage({ role: 'assistant', content: assistantContent })
          }
          yield { type: 'stop' }
          return
        }
        return
      }

      if (assistantContent) {
        this.context.addMessage({ role: 'assistant', content: assistantContent })
      }

      // No more tool calls — conversation complete
      if (toolUses.length === 0) return

      // Execute tools and feed results back to the model for the next turn
      for (const toolUse of toolUses) {
        const result = await this.executeTool(toolUse.name, toolUse.input)
        yield {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.content,
        }

        this.context.addMessage({
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input }],
        })
        this.context.addMessage({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: result.content }],
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
        error: `Tool "${name}" requires user approval (permission: ask). The tool was not executed.`,
      }
    }

    // Run PreToolUse hooks
    let effectiveParams = params
    if (this.hookEngine) {
      const preResult = await this.hookEngine.executePreToolUse(
        name,
        params,
        'session-1',
      )
      if (!preResult.allowed) {
        return {
          success: false,
          content: '',
          error: preResult.reason || `Tool "${name}" blocked by hook`,
        }
      }
      if (preResult.modifiedInput) {
        effectiveParams = { ...params, ...preResult.modifiedInput }
      }
    }

    try {
      const result = await tool.execute(effectiveParams, {
        cwd: process.cwd(),
        sessionId: 'session-1',
        provider: this.registry.getActive().config.id,
        model: this.registry.getActiveModel(),
      })

      // Run PostToolUse hooks
      if (this.hookEngine) {
        await this.hookEngine.executePostToolUse(name, effectiveParams, result, 'session-1')
      }

      return result
    } catch (err) {
      return { success: false, content: '', error: String(err) }
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

  getTools(): Map<string, ToolDefinition> {
    return this.tools
  }

  switchProvider(providerId: string, modelId?: string): void {
    this.registry.switchProvider(providerId, modelId)
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  return false
}
