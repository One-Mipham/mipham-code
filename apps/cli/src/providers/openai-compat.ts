import { execSync } from 'node:child_process'
import type { ProviderConfig, ModelInfo, Message, StreamChunk } from '../shared/index.ts'
import type { ProviderInstance, ChatRequest } from './registry'
import { fetchWithRetry } from './fetch-utils'
import { OLLAMA_PRESET_MODELS } from '../shared/constants'

export class OpenAICompatProvider implements ProviderInstance {
  constructor(public config: ProviderConfig) {}

  async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    // Accept both baseUrl and baseURL (common YAML typo)
    const rawBase = (this.config as any).baseUrl || (this.config as any).baseURL
    const baseUrl = rawBase?.replace(/\/+$/, '') || 'https://api.openai.com/v1'
    const apiKey = this.resolveApiKey(this.config.apiKey)

    const body = {
      model: req.model,
      messages: this.convertMessages(req.messages, req.systemPrompt),
      stream: true,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      tools: req.tools?.map((t) => ({ type: 'function', function: t })),
    }

    const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text()
      yield { type: 'error', error: `OpenAI API error ${response.status}: ${errText}` }
      return
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // Track incremental tool calls and reasoning content across streaming deltas
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>()
    let reasoningContent = ''

    // Streaming read timeout: if no data arrives for 90s, abort to prevent UI freeze.
    // DeepSeek V4 thinking mode can take 30-60s between chunks — 90s is a generous ceiling.
    const STREAM_READ_TIMEOUT_MS = 90_000

    while (true) {
      let readResult: Awaited<ReturnType<typeof reader.read>>
      try {
        readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Stream read timeout — no data for 90s')),
              STREAM_READ_TIMEOUT_MS,
            ),
          ),
        ])
      } catch (err) {
        yield { type: 'error', error: `Stream stalled: ${String(err)}` }
        return
      }
      const { done, value } = readResult
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') {
          // Emit any pending tool calls before stopping
          for (const [, tc] of pendingToolCalls) {
            yield {
              type: 'tool_use',
              toolUse: {
                type: 'tool_use',
                id: tc.id,
                name: tc.name,
                input: this.safeParseJson(tc.arguments),
              },
            }
          }
          yield { type: 'stop', reasoning_content: reasoningContent }
          return
        }

        try {
          const parsed = JSON.parse(data)
          const choice = parsed.choices?.[0]

          // Capture token usage when available (final chunk with stream_options.include_usage)
          if (parsed.usage) {
            yield {
              type: 'usage',
              inputTokens: parsed.usage.prompt_tokens,
              outputTokens: parsed.usage.completion_tokens,
            }
          }

          if (!choice) continue

          const delta = choice.delta

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              const pending = pendingToolCalls.get(idx) || {
                id: '',
                name: '',
                arguments: '',
              }

              if (tc.id) pending.id = tc.id
              if (tc.function?.name) pending.name = tc.function.name
              if (tc.function?.arguments) pending.arguments += tc.function.arguments

              pendingToolCalls.set(idx, pending)
            }
          }

          if (delta?.content) {
            yield { type: 'text', content: delta.content }
          }

          if (delta?.reasoning_content) {
            reasoningContent += delta.reasoning_content
          }

          if (choice.finish_reason === 'tool_calls') {
            // Emit fully accumulated tool calls
            for (const [, tc] of pendingToolCalls) {
              yield {
                type: 'tool_use',
                toolUse: {
                  type: 'tool_use',
                  id: tc.id || `call_${Date.now()}`,
                  name: tc.name,
                  input: this.safeParseJson(tc.arguments),
                },
              }
            }
            pendingToolCalls.clear()
          }

          if (choice.finish_reason === 'stop') {
            yield { type: 'stop', reasoning_content: reasoningContent }
          }
        } catch {
          // skip unparseable chunks
        }
      }
    }

    yield { type: 'stop', reasoning_content: reasoningContent }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.config.id === 'ollama') {
      return this.listOllamaModels()
    }
    return this.config.models.filter((m) => m.status === 'active')
  }

  private listOllamaModels(): ModelInfo[] {
    const seen = new Set<string>()
    const result: ModelInfo[] = []

    // 1. ollama list locally downloaded models
    try {
      const out = execSync('ollama list', { timeout: 5000, encoding: 'utf-8' })
      const lines = out.split('\n').slice(1).filter(Boolean)
      for (const line of lines) {
        const name = line.split(/\s+/)[0]!
        if (!seen.has(name)) {
          seen.add(name)
          result.push({
            id: name,
            name,
            providerId: 'ollama',
            contextWindow: 128_000,
            maxOutput: 32_000,
            vision: false,
            status: 'active',
          })
        }
      }
    } catch {
      // ollama list failed (not installed / not running) → continue with presets
    }

    // 2. Preset models (deduplicated)
    for (const preset of OLLAMA_PRESET_MODELS) {
      if (!seen.has(preset.id)) {
        seen.add(preset.id)
        result.push({
          id: preset.id,
          name: `${preset.id} [${preset.source}]`,
          providerId: 'ollama',
          contextWindow: 128_000,
          maxOutput: 32_000,
          vision: false,
          status: 'active',
        })
      }
    }

    return result
  }

  async healthCheck(): Promise<boolean> {
    try {
      const rawBase = (this.config as any).baseUrl || (this.config as any).baseURL
      const baseUrl = rawBase?.replace(/\/+$/, '') || 'https://api.openai.com/v1'
      const apiKey = this.resolveApiKey(this.config.apiKey)
      // 5s timeout so a down endpoint doesn't hang health checks (v2.1.229 alignment)
      const res = await fetchWithRetry(
        `${baseUrl}/models`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
        { timeout: 5000, maxRetries: 0 },
      )
      return res.ok
    } catch {
      return false
    }
  }

  private convertMessages(messages: Message[], systemPrompt?: string): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = []

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt })
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!
      if (!msg) continue

      // ── String content ──
      if (typeof msg.content === 'string') {
        // Combine: assistant text + next assistant message with tool_use blocks
        const next: Message | undefined = messages[i + 1]
        if (
          msg.role === 'assistant' &&
          (msg.content.length > 0 || msg.reasoning_content) &&
          next &&
          next.role === 'assistant' &&
          typeof next.content !== 'string' &&
          next.content.some((b) => b.type === 'tool_use')
        ) {
          const toolUses = next.content.filter((b) => b.type === 'tool_use')
          const combinedMsg: Record<string, unknown> = {
            role: 'assistant',
            content: msg.content,
            tool_calls: toolUses.map((tu) => ({
              id: tu.id,
              type: 'function',
              function: {
                name: tu.name,
                arguments: JSON.stringify(tu.input),
              },
            })),
            // DeepSeek V4 thinking mode: every assistant message needs reasoning_content
            reasoning_content: msg.reasoning_content || '',
          }
          result.push(combinedMsg)
          i++ // skip the next message (consumed)
          continue
        }

        const standaloneMsg: Record<string, unknown> = { role: msg.role, content: msg.content }
        // DeepSeek V4 thinking mode: every assistant message needs reasoning_content
        if (msg.role === 'assistant') {
          standaloneMsg.reasoning_content = msg.reasoning_content || ''
        }
        result.push(standaloneMsg)
        continue
      }

      // ── ContentBlock[] ──
      const blocks = msg.content
      const toolUses = blocks.filter((b) => b.type === 'tool_use')
      const toolResults = blocks.filter((b) => b.type === 'tool_result')

      // ── Assistant tool_use → OpenAI tool_calls ──
      if (toolUses.length > 0 && msg.role === 'assistant') {
        const textParts: string[] = []
        for (const b of blocks) {
          if (b.type === 'text') textParts.push(b.text)
          if (b.type === 'thinking') textParts.push(`[Thinking: ${b.thinking}]`)
        }
        const textContent = textParts.join('') || null

        const toolUseMsg: Record<string, unknown> = {
          role: 'assistant',
          content: textContent,
          tool_calls: toolUses.map((tu) => ({
            id: tu.id,
            type: 'function',
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input),
            },
          })),
          // DeepSeek V4 thinking mode: every assistant message needs reasoning_content
          reasoning_content: msg.reasoning_content || '',
        }
        result.push(toolUseMsg)
        continue
      }

      // ── Tool result → OpenAI tool role ──
      if (toolResults.length > 0) {
        // Emit companion text blocks as a user message before tool results
        const textContent =
          blocks
            .filter((b) => b.type === 'text')
            .map((b) => (b.type === 'text' ? b.text : ''))
            .join('') || null
        if (textContent) {
          result.push({ role: 'user', content: textContent })
        }

        for (const tr of toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: tr.content,
          })
        }
        continue
      }

      // ── Regular content blocks (text, image) ──
      const parts: unknown[] = []
      for (const block of blocks) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text })
        } else if (block.type === 'image_url') {
          parts.push({ type: 'image_url', image_url: block.image_url })
        }
      }
      result.push({ role: msg.role, content: parts })
    }

    return result
  }

  /** Safely parse JSON, returning an empty object on failure. */
  private safeParseJson(raw: string): Record<string, unknown> {
    if (!raw) return {}
    try {
      return JSON.parse(raw)
    } catch {
      return { _raw: raw }
    }
  }

  private resolveApiKey(keyTemplate: string): string {
    // Accept both ${VAR} and $VAR syntax
    let match = keyTemplate.match(/^\$\{(.+)\}$/)
    if (!match) match = keyTemplate.match(/^\$([A-Z_][A-Z0-9_]*)$/)
    if (match?.[1]) {
      const varName = match[1]
      const value = process.env[varName]
      if (!value) {
        process.stderr.write(
          `⚠ OpenAI-compatible provider: apiKey references $${varName} but that environment variable is not set\n`,
        )
        return ''
      }
      return value
    }
    return keyTemplate
  }
}
