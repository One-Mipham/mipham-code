import type { Message, StreamChunk, ToolDefinition, ToolResult } from '@mipham/shared'
import { ProviderRegistry } from '../providers/registry'
import { ContextManager } from './context'

export class QueryEngine {
  constructor(
    private registry: ProviderRegistry,
    private context: ContextManager,
    private tools: Map<string, ToolDefinition>,
  ) {}

  async *process(userInput: string): AsyncGenerator<StreamChunk> {
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
    let toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []

    // Stream model response
    for await (const chunk of this.registry.chat({
      model: this.registry.getActiveModel(),
      messages,
      systemPrompt,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
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

    // Execute any tools that were requested
    for (const toolUse of toolUses) {
      const result = await this.executeTool(toolUse.name, toolUse.input)
      yield {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.content,
      }

      // Add tool use + result to context
      this.context.addMessage({
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input },
        ],
      })
      this.context.addMessage({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUse.id, content: result.content },
        ],
      })
    }

    // If tools were executed, recursively continue the conversation
    if (toolUses.length > 0) {
      yield* this.continueWithTools()
    }
  }

  private async *continueWithTools(): AsyncGenerator<StreamChunk> {
    const systemPrompt = this.context.getSystemPrompt()
    const messages = this.context.getMessages()
    const toolDefs = this.getToolDefinitions()

    let assistantContent = ''
    let toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []

    for await (const chunk of this.registry.chat({
      model: this.registry.getActiveModel(),
      messages,
      systemPrompt,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
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

    if (assistantContent) {
      this.context.addMessage({ role: 'assistant', content: assistantContent })
    }

    // Execute tools (max 1 level of recursion to prevent infinite loops)
    for (const toolUse of toolUses) {
      const result = await this.executeTool(toolUse.name, toolUse.input)
      yield {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.content,
      }

      this.context.addMessage({
        role: 'assistant',
        content: [
          { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input },
        ],
      })
      this.context.addMessage({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUse.id, content: result.content },
        ],
      })
    }
  }

  private async executeTool(
    name: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { success: false, content: '', error: `Unknown tool: ${name}` }
    }

    try {
      return await tool.execute(params, {
        cwd: process.cwd(),
        sessionId: 'session-1',
        provider: this.registry.getActive().config.id,
        model: this.registry.getActiveModel(),
      })
    } catch (err) {
      return { success: false, content: '', error: String(err) }
    }
  }

  private getToolDefinitions(): Record<string, unknown>[] {
    return Array.from(this.tools.values()).map(t => ({
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
