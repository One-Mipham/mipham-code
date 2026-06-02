import type { ProviderConfig, ModelInfo, Message, StreamChunk, ContentBlock } from './shared/index.ts'
import type { ProviderInstance, ChatRequest } from './registry'

export class OpenAICompatProvider implements ProviderInstance {
  constructor(public config: ProviderConfig) {}

  async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const baseUrl = this.config.baseUrl?.replace(/\/+$/, '') || 'https://api.openai.com/v1'
    const apiKey = this.resolveApiKey(this.config.apiKey)

    const body = {
      model: req.model,
      messages: this.convertMessages(req.messages, req.systemPrompt),
      stream: true,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      tools: req.tools?.map(t => ({ type: 'function', function: t })),
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
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
        if (data === '[DONE]') {
          yield { type: 'stop' }
          return
        }

        try {
          const parsed = JSON.parse(data)
          const choice = parsed.choices?.[0]
          if (!choice) continue

          const delta = choice.delta

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              yield {
                type: 'tool_use',
                toolUse: {
                  type: 'tool_use',
                  id: tc.id || `call_${Date.now()}`,
                  name: tc.function?.name || '',
                  input: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
                },
              }
            }
            continue
          }

          if (delta?.content) {
            yield { type: 'text', content: delta.content }
          }

          if (choice.finish_reason === 'stop') {
            yield { type: 'stop' }
          }
        } catch {
          // skip unparseable chunks
        }
      }
    }

    yield { type: 'stop' }
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.config.models.filter(m => m.status === 'active')
  }

  async healthCheck(): Promise<boolean> {
    try {
      const baseUrl = this.config.baseUrl?.replace(/\/+$/, '') || 'https://api.openai.com/v1'
      const apiKey = this.resolveApiKey(this.config.apiKey)
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      return res.ok
    } catch {
      return false
    }
  }

  private convertMessages(messages: Message[], systemPrompt?: string): { role: string; content: string | unknown[] }[] {
    const result: { role: string; content: string | unknown[] }[] = []

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt })
    }

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content })
      } else {
        const parts: unknown[] = []
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text })
          } else if (block.type === 'image_url') {
            parts.push({ type: 'image_url', image_url: block.image_url })
          }
        }
        result.push({ role: msg.role, content: parts })
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
