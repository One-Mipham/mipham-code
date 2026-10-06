import type {
  ProviderConfig,
  ModelInfo,
  Message,
  StreamChunk,
  ContentBlock,
} from '../shared/index.ts'
import type { ProviderInstance, ChatRequest } from './registry'
import {
  fetchWithRetry,
  streamIdleTimeoutMs,
  isRetryableFailure,
  createAwakeTimer,
} from './fetch-utils'

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
    stop_reason?: string | null
    /**
     * Sits beside `stop_reason` on the `message_delta` event, and is the only
     * explanation that exists when a refusal comes back with no content at all.
     */
    stop_details?: { category?: string; explanation?: string }
  }
  error?: { type: string; message: string }
  usage?: { input_tokens: number; output_tokens: number }
}

/**
 * Stand-in for a tool result that has no content of its own.
 *
 * `tool_result.content` is normalized to a text block server-side, and an empty
 * one is rejected with a 400 — which fails the *whole* request, history
 * included. Multiple paths produce one: a tool that reports success with no
 * output (`content: ''`), a failed tool with no message, and a log projection
 * whose `content` never got written (`undefined`). All of them mean the same
 * thing to the model, so they get the same words.
 */
const NO_TOOL_OUTPUT = '(no output)'

/**
 * An empty text block is not a stylistic wart — Anthropic rejects it with a 400,
 * and since every message in the request is history, one such block makes the
 * conversation permanently unsendable (every later turn re-sends it).
 */
function isEmptyTextBlock(block: Record<string, unknown>): boolean {
  return block.type === 'text' && block.text === ''
}

export class AnthropicProvider implements ProviderInstance {
  private anthropicVersion = '2023-06-01'

  /**
   * Honour a user-level `baseUrl` override the way `openai-compat` does.
   *
   * The config loader treats `baseUrl` as a **routing** field — it decides where
   * the user's API key is sent, so only trusted (user-level) config may set it
   * (see `config/loader.ts`). Hard-coding the endpoint here silently dropped that
   * override: a user who pointed the provider at a proxy or gateway still had
   * every request sent to `api.anthropic.com`. Read it, with the official
   * endpoint as the fallback the default config (which sets no `baseUrl`) relies
   * on. `baseURL` is accepted too — the same common typo `openai-compat` allows.
   */
  private get baseUrl(): string {
    const raw = this.config.baseUrl ?? (this.config as { baseURL?: string }).baseURL
    return raw?.replace(/\/+$/, '') || 'https://api.anthropic.com/v1'
  }

  constructor(public config: ProviderConfig) {}

  /**
   * Are we talking to api.anthropic.com itself, or to a custom `baseUrl`?
   *
   * `anthropic-beta` is a header for Anthropic's own gateway. A custom base URL
   * is by definition some other gateway — a proxy, a corporate relay, an
   * Anthropic-compatible shim — and sending a beta flag that gateway does not
   * implement is a way to turn a working setup into `400 Bad Request` the moment
   * the endpoint changes, with nothing in the message pointing at the header.
   */
  private get isDefaultApiHost(): boolean {
    try {
      return new URL(this.baseUrl).host === 'api.anthropic.com'
    } catch {
      return false
    }
  }

  async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
    const apiKey = this.resolveApiKey(this.config.apiKey)

    // Collect accumulated tool use input (Anthropic streams tool input as partial JSON deltas)
    let currentToolName = ''
    let currentToolId = ''
    let accumulatedToolInput = ''

    // Set when the provider reports `stop_reason: 'max_tokens'` — the turn was cut
    // off at the output ceiling rather than ended by the model.
    let truncated = false

    // Set when the provider reports `stop_reason: 'refusal'`. A refusal is a
    // **successful** response (HTTP 200) that declines to answer, and it may carry
    // an empty content array — so without this the turn ends as a blank screen,
    // because `end_turn` and `refusal` both arrive at the same terminal stop below.
    let refusal: { category?: string; explanation?: string } | undefined

    // Whether this stream reached `message_stop`. A stream that runs out without
    // one was cut — a proxy or gateway closing the connection cleanly looks
    // exactly like a finished response otherwise.
    let sawTerminalEvent = false

    // Tool blocks already emitted. A replayed event is the same call, not a
    // second one; emitting it twice makes the engine run the tool twice.
    const emittedToolIds = new Set<string>()

    // Both terminal emissions go through here so the two flags can never drift
    // apart on one path. Reads `truncated`/`refusal` at call time, so it is
    // declared before either is set.
    const terminalStop = (): StreamChunk => ({
      type: 'stop',
      ...(truncated ? { truncated: true } : {}),
      ...(refusal ? { refusal } : {}),
    })

    const messages = this.convertMessages(req.messages)
    this.markPrefixCacheBreakpoint(messages)

    // Priority: explicit request override (summarizer / sub-agent call sites) >
    // the model's declared ceiling > 4096. The fallback stays: a model id that
    // isn't in `config.models` has no known ceiling.
    const declaredMaxOutput = this.config.models.find((m) => m.id === req.model)?.maxOutput

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens || declaredMaxOutput || 4096,
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
        ...(this.isDefaultApiHost ? { 'anthropic-beta': 'prompt-caching-2024-07-31' } : {}),
      },
      body: JSON.stringify(body),
      // Same as `openai-compat`: without this the caller's signal never reaches
      // the transport, and every per-call cancellation budget is decorative.
      signal: req.signal,
    })

    if (!response.ok) {
      const errText = await response.text()
      yield {
        type: 'error',
        error: `Anthropic API error ${response.status}: ${errText}`,
        retryable: isRetryableFailure(response.status),
      }
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

    // The read loop and the trailing stop share one reader, and that reader owns
    // the connection. `engine.ts` breaks out of this generator on the ordinary
    // `stop` chunk, and a sub-agent throws mid-stream on abort — both call
    // `.return()`, which unwinds through here. Without this, a turn that ends
    // normally (or is abandoned) leaves the body unread and uncancelled, so the
    // socket can't be reused. `cancel()` on an already-errored stream rejects, and
    // on a closed one is a no-op — the catch covers the first.
    try {
      while (true) {
        let readResult: Awaited<ReturnType<typeof reader.read>>
        let cancelIdle: (() => void) | undefined
        try {
          readResult = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              cancelIdle = createAwakeTimer(STREAM_READ_TIMEOUT_MS, () =>
                reject(
                  new Error(
                    `Stream read timeout — no data for ${Math.round(STREAM_READ_TIMEOUT_MS / 1000)}s`,
                  ),
                ),
              )
            }),
          ])
        } catch (err) {
          yield { type: 'error', error: `Stream stalled: ${String(err)}` }
          return
        } finally {
          cancelIdle?.()
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
                // 此刻还无从得知本轮是否被截断 —— `stop_reason` 要到后面的
                // `message_delta` 才到（见下方同名分支）。所以被截断的 `tool_use`
                // 在这里已经发出去了；openai-compat 那条路上「截断即丢弃未完成的
                // tool_call」的处置，这里结构上做不到（它的 finish_reason 与
                // tool_calls 落在同一个响应体里）。**这是有意的不对称，不是漏做**：
                // 要在这里丢弃，就得把 `tool_use` 缓冲到 `message_stop` 再发 ——
                // 那是一次行为变更，不属本次范围。
                if (currentToolId && currentToolName && accumulatedToolInput) {
                  // A replayed block carries the id it was first sent with, so the
                  // id is what tells a second call apart from the same call twice.
                  if (!emittedToolIds.has(currentToolId)) {
                    emittedToolIds.add(currentToolId)

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
                // `max_tokens` means the turn hit the output ceiling. Without this the
                // truncation is indistinguishable from `end_turn`: both arrive here and
                // the terminal stop below looks the same either way.
                const stopReason = event.delta?.stop_reason
                if (stopReason === 'max_tokens') {
                  truncated = true
                }
                // A refusal is a successful response that declines to answer, and
                // it can arrive with no content at all. Capture the provider's own
                // reason here — it is the only one that will ever exist, and the
                // stream is the only place it appears.
                if (stopReason === 'refusal') {
                  refusal = {}
                  const details = event.delta?.stop_details
                  if (details?.category !== undefined) refusal.category = details.category
                  if (details?.explanation !== undefined) refusal.explanation = details.explanation
                }
                break
              }

              case 'message_stop': {
                sawTerminalEvent = true
                yield terminalStop()
                return
              }

              case 'error': {
                yield {
                  type: 'error',
                  error: event.error?.message || 'Unknown Anthropic error',
                  retryable: isRetryableFailure(undefined, event.error?.type),
                }
                return
              }
            }
          } catch {
            // Skip unparseable SSE events
          }
        }
      }

      // The stream ran out without `message_stop`. Whatever stopped it, the turn is
      // incomplete — and this is the only place that knows, because a cleanly
      // closed connection and a finished response are otherwise the same stream.
      if (!sawTerminalEvent) truncated = true

      yield terminalStop()
    } finally {
      await reader.cancel().catch(() => {})
    }
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
        const content: unknown[] = []
        // 空串不产出 text 块（见 isEmptyTextBlock）：用户发了个空消息、或工具返回
        // 空内容时会走到这里，而它会让之后每一轮都 400。
        if (msg.content !== '') content.push({ type: 'text', text: msg.content })
        // DeepSeek V4 thinking mode via Anthropic endpoint: every assistant
        // message must contain a thinking block if any message in history does.
        if (msg.role === 'assistant') {
          const thinkingText = (msg as any).reasoning_content || ''
          content.unshift({ type: 'thinking', thinking: thinkingText })
        }
        // 全部内容都被滤掉的消息**整条**不下发 —— 空 content 数组同样被 API 拒。
        if (content.length > 0) {
          result.push({
            role: msg.role,
            content,
          })
        }
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
                // 空 content 同样整条请求被拒（见 NO_TOOL_OUTPUT）。`||` 而非 `=== ''`：
                // 投影层缺失该字段时这里是 `undefined`，空数组同理。
                // 非字符串（工具/MCP/插件违约返回对象或数字）同样要先成文本 ——
                // 直接透传会作为 JSON 值进请求体，而 API 只收字符串。
                content:
                  (typeof block.content === 'string'
                    ? block.content
                    : JSON.stringify(block.content)) || NO_TOOL_OUTPUT,
                // 只在失败时下发 —— 成功请求体与改动前逐字节相同，不引入 prompt-cache 前缀抖动
                ...(block.is_error === true ? { is_error: true } : {}),
              }

            default:
              // 未知块类型**无法**原样表达，而 `{type:'text',text:''}` 是一个必然被拒
              // 的载荷 —— 改成丢这一个块（下面的 filter），而不是拿它毒掉整条请求。
              return null
          }
        }) as (Record<string, unknown> | null)[]

        // 丢掉表达不出来的块（未知类型）与空的 text 块。
        const kept = blocks.filter(
          (b): b is Record<string, unknown> => b !== null && !isEmptyTextBlock(b),
        )

        // DeepSeek V4 thinking mode via Anthropic endpoint: every assistant
        // message must contain a thinking block if any message in history does.
        if (msg.role === 'assistant' && !kept.some((b) => b.type === 'thinking')) {
          kept.unshift({ type: 'thinking', thinking: '' })
        }
        if (kept.length === 0) continue
        result.push({ role: msg.role, content: kept })
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
