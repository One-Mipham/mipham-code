import type {
  ProviderConfig,
  ModelInfo,
  Message,
  StreamChunk,
  ContentBlock,
} from '../shared/index.ts'
import type { ProviderInstance, ChatRequest } from './registry'
import { fetchWithRetry } from './fetch-utils'

interface AnthropicContentBlock {
  type: string
  text?: string
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

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens || 4096,
      stream: true,
      messages: this.convertMessages(req.messages),
    }

    if (req.systemPrompt) {
      body.system = req.systemPrompt
    }

    if (req.temperature !== undefined) {
      body.temperature = req.temperature
    }

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters || t.input_schema || { type: 'object', properties: {} },
      }))
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

    while (true) {
      const { done, value } = await reader.read()
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
              // Contains stop_reason and usage info
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

  private convertMessages(messages: Message[]): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = []

    for (const msg of messages) {
      // Anthropic does not allow 'system' role in messages array — it goes to top-level system param
      if (msg.role === 'system') continue

      if (typeof msg.content === 'string') {
        result.push({
          role: msg.role,
          content: [{ type: 'text', text: msg.content }],
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

        result.push({ role: msg.role, content: blocks })
      }
    }

    return result
  }

  private resolveApiKey(keyTemplate: string): string {
    const match = keyTemplate.match(/^\$\{(.+)\}$/)
    if (match?.[1]) {
      return process.env[match[1]] || ''
    }
    return keyTemplate
  }
}
