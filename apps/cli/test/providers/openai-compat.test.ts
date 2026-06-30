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

  // ═══════════════════════════════════════════
  // Config
  // ═══════════════════════════════════════════

  it('should expose config via public property', () => {
    const config = makeConfig()
    const provider = new OpenAICompatProvider(config)
    expect(provider.config).toBe(config)
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
