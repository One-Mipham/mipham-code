import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProviderConfig, StreamChunk } from '@mipham/shared'
import { OpenAICompatProvider } from '../../src/providers/openai-compat'

// ── Helpers ──

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'sk-test-key-direct',
    models: [
      {
        id: 'gpt-5',
        name: 'GPT-5',
        providerId: 'openai',
        contextWindow: 128_000,
        maxOutput: 32_000,
        vision: true,
        status: 'active',
      },
      {
        id: 'gpt-4',
        name: 'GPT-4',
        providerId: 'openai',
        contextWindow: 32_000,
        maxOutput: 8_000,
        vision: false,
        status: 'deprecated',
      },
    ],
    ...overrides,
  }
}

async function collectChunks(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const c of gen) chunks.push(c)
  return chunks
}

function makeSSEResponse(lines: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      const text = lines.join('\n') + '\n'
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })

  return new Response(body, { status: 200 })
}

// ── Tests ──

describe('OpenAICompatProvider', () => {
  // Use real env for API key resolution tests
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  // ═══════════════════════════════════════════
  // chat — happy path
  // ═══════════════════════════════════════════

  it('should stream text chunks from SSE response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeSSEResponse([
          'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}',
          'data: {"choices":[{"delta":{"content":" world"},"index":0}]}',
          'data: {"choices":[{"finish_reason":"stop"}],"index":0}',
          'data: [DONE]',
        ]),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    const chunks = await collectChunks(
      provider.chat({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
    )

    const textChunks = chunks.filter((c) => c.type === 'text')
    expect(textChunks).toHaveLength(2)
    expect(textChunks[0]!.content).toBe('Hello')
    expect(textChunks[1]!.content).toBe(' world')
    expect(chunks.some((c) => c.type === 'stop')).toBe(true)
  })

  it('should send system prompt as system message', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: [DONE]'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    await collectChunks(
      provider.chat({
        model: 'gpt-5',
        messages: [],
        systemPrompt: 'You are helpful.',
      }),
    )

    const messages = capturedBody.messages as Array<{ role: string }>
    expect(messages[0]).toEqual({ role: 'system', content: 'You are helpful.' })
  })

  // 引擎把「上一轮 provider 出错」存成数组里的 `system` 条目（好让 resume 渲染 ⚠ 行）。
  // 它是一句 **UI 说明**，不是指令 —— 而 `system` 是最高权限的角色，且这句话里嵌着
  // provider 给的原文。所以它不能原样发出去。
  it('mid-array system 条目不以 system 角色发出（是 UI 行，不是指令）', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: [DONE]'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    await collectChunks(
      provider.chat({
        model: 'gpt-5',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'system', content: '⚠ Model error: boom' },
          { role: 'assistant', content: 'retry' },
        ],
      }),
    )

    const messages = capturedBody.messages as Array<{ role: string; content: string }>
    // 前半：它没被**当成指令**发出去（角色序列里没有 system）
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    // 后半：它的**正文也一并消失** —— 只改角色、内容仍随请求出去，仍等于把这段话
    // 送进对话（只是换了名义）。两半在同一次请求上取反，各自承重。
    expect(JSON.stringify(messages)).not.toContain('boom')
  })

  // 对照：`system` 条目并非一律被丢 —— 数组**开头**的那个仍是合法 header（引擎自己的
  // 汇总调用曾用这个形状，且 OpenAI 兼容端点确实接受开头一条 system）。
  it('没有 systemPrompt 时，开头的 system 条目仍然原样发出', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: [DONE]'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    await collectChunks(
      provider.chat({
        model: 'gpt-5',
        messages: [
          { role: 'system', content: 'You are terse.' },
          { role: 'user', content: 'hi' },
        ],
      }),
    )

    const messages = capturedBody.messages as Array<{ role: string }>
    expect(messages[0]).toEqual({ role: 'system', content: 'You are terse.' })
    expect(messages).toHaveLength(2)
  })

  // 原测试名 `should default max_tokens to 8192 when not specified` 断言的是**旧（错）行为**：
  // 它把「模型声明的 maxOutput 从不被使用」这个缺陷固化成了绿灯（`makeConfig()` 给 gpt-5
  // 声明了 maxOutput: 32_000，而发出的永远是 8192）。故拆成两条：一条把声明值换成正确行为，
  // 一条保留原测试的真意 —— 兜底仍在（未声明的模型 id 没有可发的上限）。
  it('sends the declared maxOutput instead of the 8192 fallback (gpt-5 → 32000)', async () => {
    // 会让这条失败的改动：把 max_tokens 退回 `req.maxTokens || 8192`（声明值再次无施加点），
    // 或改成 `req.maxTokens` 缺省时忽略 config.models 里的声明。
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: [DONE]'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    await collectChunks(
      provider.chat({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
    )

    expect(capturedBody.max_tokens).toBe(32_000)
  })

  it('falls back to 8192 when the model declares no maxOutput', async () => {
    // 会让这条失败的改动：把声明值路径写成无兜底（未声明的 id ⇒ undefined ⇒ 请求体
    // 少一个 max_tokens，或发出 `max_tokens: undefined`）。
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: [DONE]'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    await collectChunks(
      provider.chat({ model: 'not-a-declared-model', messages: [{ role: 'user', content: 'hi' }] }),
    )

    expect(capturedBody.max_tokens).toBe(8192)
  })

  it('should include tools with function wrapper', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: [DONE]'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    await collectChunks(
      provider.chat({
        model: 'gpt-5',
        messages: [],
        tools: [{ name: 'read', description: 'Read file', parameters: {} }],
      }),
    )

    const tools = capturedBody.tools as Array<{
      type: string
      function: Record<string, unknown>
    }>
    expect(tools).toHaveLength(1)
    expect(tools[0]!.type).toBe('function')
    expect(tools[0]!.function.name).toBe('read')
  })

  it('should convert multi-modal messages with images', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: [DONE]'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    await collectChunks(
      provider.chat({
        model: 'gpt-5',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this:' },
              { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
            ],
          },
        ],
      }),
    )

    const messages = capturedBody.messages as Array<{
      role: string
      content: Array<{ type: string }>
    }>
    expect(messages[0]!.role).toBe('user')
    expect(Array.isArray(messages[0]!.content)).toBe(true)
    const parts = messages[0]!.content as Array<{ type: string }>
    expect(parts[0]).toEqual({ type: 'text', text: 'Describe this:' })
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/img.png' },
    })
  })

  // ═══════════════════════════════════════════
  // chat — tool calls
  // ═══════════════════════════════════════════

  it('should yield tool_use for tool_calls in SSE delta', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeSSEResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"read","arguments":"{\\"file\\":\\"a.ts\\"}"}}]},"index":0}]}',
          'data: [DONE]',
        ]),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    const chunks = await collectChunks(provider.chat({ model: 'gpt-5', messages: [] }))

    const toolUses = chunks.filter((c) => c.type === 'tool_use')
    expect(toolUses).toHaveLength(1)
    expect(toolUses[0]!.toolUse!.name).toBe('read')
    expect(toolUses[0]!.toolUse!.input).toEqual({ file: 'a.ts' })
  })

  it('assigns a fallback id to a tool call missing an id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeSSEResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"read","arguments":"{\\"file\\":\\"a.ts\\"}"}}]},"index":0}]}',
          'data: [DONE]',
        ]),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    const chunks = await collectChunks(provider.chat({ model: 'gpt-5', messages: [] }))

    const toolUses = chunks.filter((c) => c.type === 'tool_use')
    expect(toolUses).toHaveLength(1)
    expect(toolUses[0]!.toolUse!.id).toMatch(/^call_/)
    expect(toolUses[0]!.toolUse!.name).toBe('read')
  })

  it('drops a tool call missing a name', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeSSEResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"arguments":"{\\"x\\":1}"}}]},"index":0}]}',
          'data: [DONE]',
        ]),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    const chunks = await collectChunks(provider.chat({ model: 'gpt-5', messages: [] }))

    const toolUses = chunks.filter((c) => c.type === 'tool_use')
    expect(toolUses).toHaveLength(0)
  })

  // ═══════════════════════════════════════════
  // chat — output truncation (finish_reason: 'length')
  // ═══════════════════════════════════════════

  it('test_a_length_finish_reason_marks_the_stop_as_truncated', async () => {
    // 会让这条失败的改动：删掉 `finish_reason === 'length'` 分支（截断重新落回
    // 「两个分支都不进」的洞里，末帧无条件 stop 抹平一切），或让该分支的 stop
    // 不带 truncated；以及在无条件兜底 stop 上也设 truncated（那会把正常结束标成截断）。
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeSSEResponse([
          'data: {"choices":[{"delta":{"content":"半截话"},"index":0}]}',
          'data: {"choices":[{"finish_reason":"length"}],"index":0}',
        ]),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    const chunks = await collectChunks(provider.chat({ model: 'gpt-5', messages: [] }))

    const truncatedStops = chunks.filter((c) => c.type === 'stop' && c.truncated === true)
    expect(truncatedStops).toHaveLength(1)
  })

  it('test_a_normal_stop_does_not_carry_the_truncated_key', async () => {
    // 会让这条失败的改动：把 truncated 恒设（`truncated: false` 出现在每个 stop 上）——
    // 那会让每一次正常结束的 WS 消息都多一个字段（一次 prompt-cache 前缀抖动）。
    // **只断 `truncated === false` 抓不到这种改动**：`toEqual` 忽略值为 `undefined`
    // 的属性，故必须用 `'truncated' in chunk === false` 钉住键本身不存在。
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeSSEResponse([
          'data: {"choices":[{"delta":{"content":"done"},"index":0}]}',
          'data: {"choices":[{"finish_reason":"stop"}],"index":0}',
          'data: [DONE]',
        ]),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    const chunks = await collectChunks(provider.chat({ model: 'gpt-5', messages: [] }))

    const stops = chunks.filter((c) => c.type === 'stop')
    expect(stops.length).toBeGreaterThan(0)
    for (const stop of stops) {
      expect('truncated' in stop).toBe(false)
    }
  })

  it('test_a_truncated_turn_drops_the_incomplete_tool_call', async () => {
    // 会让这条失败的改动：在 length 分支只 yield stop、忘了 `pendingToolCalls.clear()`
    // —— 随后的 `[DONE]` 处理分支会把参数被截断的半个 tool_call 当完整调用下发
    // （`safeParseJson` 对坏 JSON 返回 `{ _raw: … }`，调用方看到的是一个参数错的调用）。
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeSSEResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"file\\":\\"a.t"}}]},"index":0}]}',
          'data: {"choices":[{"finish_reason":"length"}],"index":0}',
          'data: [DONE]',
        ]),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    const chunks = await collectChunks(provider.chat({ model: 'gpt-5', messages: [] }))

    expect(chunks.filter((c) => c.type === 'tool_use')).toHaveLength(0)
  })

  it('test_the_request_sends_the_models_declared_max_output', async () => {
    // 会让这条失败的改动：`max_tokens` 退回常量兜底（`req.maxTokens || 8192`），
    // 或把优先级顺序调成「声明值 > 显式 req.maxTokens」。
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: [DONE]'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    await collectChunks(provider.chat({ model: 'gpt-5', messages: [] }))

    // gpt-5 在 makeConfig() 里声明 maxOutput: 32_000
    expect(capturedBody.max_tokens).toBe(32_000)
  })

  // ═══════════════════════════════════════════
  // chat — error handling
  // ═══════════════════════════════════════════

  it('should yield error on non-OK response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    const chunks = await collectChunks(provider.chat({ model: 'gpt-5', messages: [] }))

    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.type).toBe('error')
    expect(chunks[0]!.error).toContain('401')
  })

  it('should yield error when response body is null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    const chunks = await collectChunks(provider.chat({ model: 'gpt-5', messages: [] }))

    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.type).toBe('error')
    expect(chunks[0]!.error).toContain('No response body')
  })

  // ═══════════════════════════════════════════
  // API key resolution
  // ═══════════════════════════════════════════

  it('should resolve API key from env var pattern ${NAME}', async () => {
    process.env.TEST_KEY = 'resolved-key'
    let capturedHeaders: Record<string, string> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedHeaders = (opts.headers || {}) as Record<string, string>
      return makeSSEResponse(['data: [DONE]'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig({ apiKey: '${TEST_KEY}' }))
    await collectChunks(provider.chat({ model: 'gpt-5', messages: [] }))

    expect(capturedHeaders['Authorization']).toBe('Bearer resolved-key')
  })

  it('should use direct key when no env var pattern', async () => {
    let capturedHeaders: Record<string, string> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedHeaders = (opts.headers || {}) as Record<string, string>
      return makeSSEResponse(['data: [DONE]'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig({ apiKey: 'sk-direct-key' }))
    await collectChunks(provider.chat({ model: 'gpt-5', messages: [] }))

    expect(capturedHeaders['Authorization']).toBe('Bearer sk-direct-key')
  })

  it('should return empty string for missing env var', async () => {
    delete process.env.MISSING_KEY
    let capturedHeaders: Record<string, string> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedHeaders = (opts.headers || {}) as Record<string, string>
      return makeSSEResponse(['data: [DONE]'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig({ apiKey: '${MISSING_KEY}' }))
    await collectChunks(provider.chat({ model: 'gpt-5', messages: [] }))

    expect(capturedHeaders['Authorization']).toBe('Bearer ')
  })

  // ═══════════════════════════════════════════
  // listModels
  // ═══════════════════════════════════════════

  it('should list only active models', async () => {
    const provider = new OpenAICompatProvider(makeConfig())
    const models = await provider.listModels()

    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe('gpt-5')
    expect(models[0]!.status).toBe('active')
  })

  it('should exclude deprecated models', async () => {
    const provider = new OpenAICompatProvider(makeConfig())
    const models = await provider.listModels()

    const deprecated = models.find((m) => m.status === 'deprecated')
    expect(deprecated).toBeUndefined()
  })

  // ═══════════════════════════════════════════
  // healthCheck
  // ═══════════════════════════════════════════

  it('should return true on successful health check', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    const healthy = await provider.healthCheck()

    expect(healthy).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/models'),
      expect.objectContaining({
        headers: expect.anything(),
      }),
    )
    // Verify the auth header was set correctly
    const callHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(callHeaders?.['Authorization']).toBe('Bearer sk-test-key-direct')
  })

  it('should return false when fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    const healthy = await provider.healthCheck()

    expect(healthy).toBe(false)
  })

  it('should return false on non-200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig())
    const healthy = await provider.healthCheck()

    expect(healthy).toBe(false)
  })

  it('should resolve env-var templates in baseUrl (${MIPHAM_BASE_URL})', async () => {
    process.env.MIPHAM_BASE_URL = 'http://resolved.example.com/v1'
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig({ baseUrl: '${MIPHAM_BASE_URL}' }))
    const healthy = await provider.healthCheck()

    expect(healthy).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://resolved.example.com/v1/models',
      expect.anything(),
    )
    delete process.env.MIPHAM_BASE_URL
  })

  // ═══════════════════════════════════════════
  // Config
  // ═══════════════════════════════════════════

  it('should expose config via public property', () => {
    const config = makeConfig()
    const provider = new OpenAICompatProvider(config)
    expect(provider.config).toBe(config)
  })

  // 恢复一个**在工具调用中途**结束的会话时，历史里那条调用必须有结果回应：
  // `tool_calls` 挂着而没有后面的 tool 消息，端点会整条拒收（400）。这条在**出网**
  // 这一层量它 —— 投影里「有没有那条 tool_result」是上游的事，这里读的是真正发出去的
  // 请求体，两半对不上就红。
  it('a resumed interrupted call is answered in the request body — and unanswered without the repair', async () => {
    const { SessionLog, closeInterruptedToolCalls, deriveMessages } =
      await import('../../src/core/session-log')
    const log = new SessionLog('interrupted')
    log.append({ type: 'session/start', at: 1, sessionId: 's1' })
    log.append({ type: 'user/message', at: 2, message: { role: 'user', content: 'run the thing' } })
    log.append({ type: 'tool/call', at: 3, id: 'call_1', name: 'probe', input: {} })

    const broken = deriveMessages(log.events())
    closeInterruptedToolCalls(log)
    const repaired = deriveMessages(log.events())

    async function bodyFor(messages: typeof repaired): Promise<Record<string, unknown>[]> {
      let captured: Record<string, unknown> = {}
      globalThis.fetch = vi.fn().mockImplementation(async (_url, opts) => {
        captured = JSON.parse((opts as { body: string }).body)
        return makeSSEResponse(['data: [DONE]'])
      }) as unknown as typeof fetch
      await collectChunks(new OpenAICompatProvider(makeConfig()).chat({ model: 'gpt-5', messages }))
      return captured.messages as Record<string, unknown>[]
    }

    const callIds = (body: Record<string, unknown>[]) =>
      body.flatMap((m) => ((m.tool_calls as { id: string }[] | undefined) ?? []).map((c) => c.id))
    const answeredIds = (body: Record<string, unknown>[]) =>
      body.filter((m) => m.role === 'tool').map((m) => m.tool_call_id as string)

    // The premise, measured at the boundary: as it comes off disk, the call is
    // asked for and never answered — which is what the endpoint refuses.
    const brokenBody = await bodyFor(broken)
    expect(callIds(brokenBody)).toEqual(['call_1'])
    expect(answeredIds(brokenBody)).toEqual([])

    const repairedBody = await bodyFor(repaired)
    expect(callIds(repairedBody)).toEqual(['call_1'])
    expect(answeredIds(repairedBody)).toEqual(['call_1'])
    // The result carries the reason, so the model knows to check rather than guess.
    const toolMsg = repairedBody.find((m) => m.role === 'tool')!
    expect(String(toolMsg.content)).toMatch(/unknown/i)
  })

  it('should strip trailing slashes from baseUrl', async () => {
    let capturedUrl = ''
    const fetchMock = vi.fn().mockImplementation(async (url) => {
      capturedUrl = url as string
      return makeSSEResponse(['data: [DONE]'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new OpenAICompatProvider(makeConfig({ baseUrl: 'https://api.test.com/v1///' }))
    await collectChunks(provider.chat({ model: 'gpt-5', messages: [] }))

    expect(capturedUrl).toBe('https://api.test.com/v1/chat/completions')
  })
})
