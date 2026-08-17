import type {
  ProviderConfig,
  ModelInfo,
  Message,
  StreamChunk,
  ContentBlock,
} from '../shared/index.ts'
import type { ProviderInstance, ChatRequest } from './registry'
import { fetchWithRetry, streamIdleTimeoutMs } from './fetch-utils'

interface AnthropicContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  source?: { type: string; media_type: string; data: string }
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
}

interface AnthropicSSEEvent {
  type: string
  message?: {
    content: AnthropicContentBlock[]
    stop_reason: string | null
  }
  index?: number
  content_block?: AnthropicContentBlock
  delta?: {
    type: string
    text?: string
    thinking?: string
    partial_json?: string
  }
  error?: { type: string; message: string }
  usage?: { input_tokens: number; output_tokens: number }
}

export class AnthropicProvider implements ProviderInstance {
  private baseUrl = 'https://api.anthropic.com/v1'
  private anthropicVersion = '2023-06-01'

  constructor(public config: ProviderConfig) {}

  async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const apiKey = this.resolveApiKey(this.config.apiKey)

    // Collect accumulated tool use input (Anthropic streams tool input as partial JSON deltas)
    let currentToolName = ''
    let currentToolId = ''
    let accumulatedToolInput = ''

    const messages = this.convertMessages(req.messages)
    this.markPrefixCacheBreakpoint(messages)

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens || 4096,
      stream: true,
      messages,
    }

    if (req.systemPrompt) {
      // Mark the system prompt for prompt caching — it's the largest stable
      // block and byte-identical across turns, so it always hits the cache.
      body.system = [{ type: 'text', text: req.systemPrompt, cache_control: { type: 'ephemeral' } }]
    }

    if (req.temperature !== undefined) {
      body.temperature = req.temperature
    }

    if (req.tools && req.tools.length > 0) {
      const tools: Record<string, unknown>[] = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters || t.input_schema || { type: 'object', properties: {} },
      }))
      // Cache the tools: mark the last tool definition as a breakpoint.
      tools[tools.length - 1]!.cache_control = { type: 'ephemeral' }
      body.tools = tools
    }

    const response = await fetchWithRetry(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': this.anthropicVersion,
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errText = await response.text()
      yield { type: 'error', error: `Anthropic API error ${response.status}: ${errText}` }
      return
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body' }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // Streaming idle timeout: scaled by reasoning effort so extended thinking
    // passes aren't mistaken for a stalled connection.
    const STREAM_READ_TIMEOUT_MS = streamIdleTimeoutMs(req.effort)

    while (true) {
      let readResult: Awaited<ReturnType<typeof reader.read>>
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      try {
        readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            idleTimer = setTimeout(
              () =>
                reject(
                  new Error(
                    `Stream read timeout — no data for ${Math.round(STREAM_READ_TIMEOUT_MS / 1000)}s`,
                  ),
                ),
              STREAM_READ_TIMEOUT_MS,
            )
          }),
        ])
      } catch (err) {
        yield { type: 'error', error: `Stream stalled: ${String(err)}` }
        return
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
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

        try {
          const event = JSON.parse(data) as AnthropicSSEEvent

          switch (event.type) {
            case 'content_block_start': {
              const cb = event.content_block
              if (!cb) continue

              if (cb.type === 'tool_use') {
                currentToolName = cb.name || ''
                currentToolId = cb.id || ''
                accumulatedToolInput = ''
              }
              break
            }

            case 'content_block_delta': {
              const delta = event.delta
              if (!delta) continue

              if (delta.type === 'text_delta' && delta.text) {
                yield { type: 'text', content: delta.text }
              }

              if (delta.type === 'thinking_delta' && delta.text) {
                yield { type: 'thinking', thinking: delta.text }
              }

              if (delta.type === 'input_json_delta' && delta.partial_json) {
                accumulatedToolInput += delta.partial_json
              }
              break
            }

            case 'content_block_stop': {
              if (currentToolId && currentToolName && accumulatedToolInput) {
                let parsedInput: Record<string, unknown> = {}
                try {
                  parsedInput = JSON.parse(accumulatedToolInput)
                } catch {
                  parsedInput = { _raw: accumulatedToolInput }
                }

                yield {
                  type: 'tool_use',
                  toolUse: {
                    type: 'tool_use',
                    id: currentToolId,
                    name: currentToolName,
                    input: parsedInput,
                  },
                }

                // Reset accumulator
                currentToolName = ''
                currentToolId = ''
                accumulatedToolInput = ''
              }
              break
            }

            case 'message_delta': {
              // Capture token usage for accurate cost tracking
              if (event.usage) {
                yield {
                  type: 'usage',
                  inputTokens: event.usage.input_tokens,
                  outputTokens: event.usage.output_tokens,
                }
              }
              // Contains stop_reason; also handles late input_json_delta
              if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                accumulatedToolInput += event.delta.partial_json
              }
              break
            }

            case 'message_stop': {
              yield { type: 'stop' }
              return
            }

            case 'error': {
              yield { type: 'error', error: event.error?.message || 'Unknown Anthropic error' }
              return
            }
          }
        } catch {
          // Skip unparseable SSE events
        }
      }
    }

    yield { type: 'stop' }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.config.models.filter((m) => m.status === 'active')
  }

  async healthCheck(): Promise<boolean> {
    // Anthropic doesn't have a public models list endpoint
    // Use a lightweight check — verify API key format exists
    const apiKey = this.resolveApiKey(this.config.apiKey)
    return apiKey.length > 0 && apiKey.startsWith('sk-ant-')
  }

  /**
   * Mark the stable conversation prefix for prompt caching. The breakpoint is
   * placed on the last block of the second-to-last message, leaving only the
   * newest message uncached.
   */
  private markPrefixCacheBreakpoint(messages: Record<string, unknown>[]): void {
    if (messages.length < 2) return
    const boundary = messages[messages.length - 2]!
    const content = boundary.content
    if (!Array.isArray(content) || content.length === 0) return
    const lastBlock = content[content.length - 1] as Record<string, unknown>
    lastBlock.cache_control = { type: 'ephemeral' }
  }

  private convertMessages(messages: Message[]): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = []

    for (const msg of messages) {
      // Anthropic does not allow 'system' role in messages array — it goes to top-level system param
      if (msg.role === 'system') continue

      if (typeof msg.content === 'string') {
        const content: unknown[] = [{ type: 'text', text: msg.content }]
        // DeepSeek V4 thinking mode via Anthropic endpoint: every assistant
        // message must contain a thinking block if any message in history does.
        if (msg.role === 'assistant') {
          const thinkingText = (msg as any).reasoning_content || ''
          content.unshift({ type: 'thinking', thinking: thinkingText })
        }
        result.push({
          role: msg.role,
          content,
        })
      } else {
        const blocks = (msg.content as ContentBlock[]).map((block) => {
          switch (block.type) {
            case 'text':
              return { type: 'text', text: block.text }

            case 'image_url': {
              const url = block.image_url.url
              // Handle data URIs (base64) and regular URLs
              if (url.startsWith('data:')) {
                const [header, data] = url.split(',')
                const mediaType = header?.match(/data:(image\/\w+);base64/)?.[1] || 'image/png'
                return {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: data || '',
                  },
                }
              }
              // For regular URLs, pass as image_url (Anthropic might not support directly)
              return {
                type: 'image',
                source: {
                  type: 'url',
                  url,
                },
              }
            }

            case 'thinking':
              return {
                type: 'thinking',
                thinking: block.thinking,
              }

            case 'tool_use':
              return {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.input,
              }

            case 'tool_result':
              return {
                type: 'tool_result',
                tool_use_id: block.tool_use_id,
                content: block.content,
              }

            default:
              return { type: 'text', text: '' }
          }
        })

        // DeepSeek V4 thinking mode via Anthropic endpoint: every assistant
        // message must contain a thinking block if any message in history does.
        if (msg.role === 'assistant' && !blocks.some((b: any) => b.type === 'thinking')) {
          blocks.unshift({ type: 'thinking', thinking: '' })
        }
        result.push({ role: msg.role, content: blocks })
      }
    }

    return result
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
          `⚠ Anthropic provider: apiKey references $${varName} but that environment variable is not set\n`,
        )
        return ''
      }
      return value
    }
    return keyTemplate
  }
}
