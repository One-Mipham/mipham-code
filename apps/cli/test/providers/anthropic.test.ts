import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProviderConfig, StreamChunk } from '@mipham/shared'
import { AnthropicProvider } from '../../src/providers/anthropic'

// ── Helpers ──

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    apiKey: 'sk-ant-direct-key',
    models: [
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        providerId: 'anthropic',
        contextWindow: 1_000_000,
        maxOutput: 128_000,
        vision: true,
        status: 'active',
      },
      {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        providerId: 'anthropic',
        contextWindow: 200_000,
        maxOutput: 32_000,
        vision: true,
        status: 'active',
      },
      {
        id: 'claude-opus-4',
        name: 'Claude Opus 4',
        providerId: 'anthropic',
        contextWindow: 200_000,
        maxOutput: 32_000,
        vision: true,
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

describe('AnthropicProvider', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  // ═══════════════════════════════════════════
  // chat — text streaming (content_block_delta)
  // ═══════════════════════════════════════════

  it('should stream text from content_block_delta events', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeSSEResponse([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
          'data: {"type":"content_block_stop","index":0}',
          'data: {"type":"message_stop"}',
        ]),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    const chunks = await collectChunks(
      provider.chat({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )

    const textChunks = chunks.filter((c) => c.type === 'text')
    expect(textChunks).toHaveLength(2)
    expect(textChunks[0]!.content).toBe('Hello')
    expect(textChunks[1]!.content).toBe(' world')
    expect(chunks.some((c) => c.type === 'stop')).toBe(true)
  })

  it('should ignore system-role messages in messages array', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: {"type":"message_stop"}'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    await collectChunks(
      provider.chat({
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'system', content: 'You are a bot.' },
          { role: 'user', content: 'hello' },
        ],
      }),
    )

    const messages = capturedBody.messages as Array<{ role: string }>
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
  })

  it('should send system prompt as top-level system field', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: {"type":"message_stop"}'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    await collectChunks(
      provider.chat({
        model: 'claude-sonnet-4-6',
        messages: [],
        systemPrompt: 'You are a helpful assistant.',
      }),
    )

    expect(capturedBody.system).toBe('You are a helpful assistant.')
  })

  it('should send tools with input_schema', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: {"type":"message_stop"}'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    await collectChunks(
      provider.chat({
        model: 'claude-sonnet-4-6',
        messages: [],
        tools: [
          {
            name: 'read',
            description: 'Read file',
            parameters: { type: 'object', properties: {} },
          },
        ],
      }),
    )

    const tools = capturedBody.tools as Array<{ name: string; input_schema: unknown }>
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('read')
    expect(tools[0]!.input_schema).toEqual({ type: 'object', properties: {} })
  })

  // ═══════════════════════════════════════════
  // chat — tool use (accumulated JSON input)
  // ═══════════════════════════════════════════

  it('should yield tool_use on content_block_stop with accumulated input', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeSSEResponse([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_001","name":"read"}}',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file\\":\\""}}',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"test.ts\\"}"}}',
          'data: {"type":"content_block_stop","index":0}',
          'data: {"type":"message_stop"}',
        ]),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    const chunks = await collectChunks(
      provider.chat({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'read test.ts' }],
      }),
    )

    const toolUses = chunks.filter((c) => c.type === 'tool_use')
    expect(toolUses).toHaveLength(1)
    expect(toolUses[0]!.toolUse!.name).toBe('read')
    expect(toolUses[0]!.toolUse!.id).toBe('toolu_001')
    expect(toolUses[0]!.toolUse!.input).toEqual({ file: 'test.ts' })
  })

  it('should handle malformed JSON in tool input gracefully', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeSSEResponse([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"bash"}}',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"not valid json"}}',
          'data: {"type":"content_block_stop","index":0}',
          'data: {"type":"message_stop"}',
        ]),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    const chunks = await collectChunks(provider.chat({ model: 'claude-sonnet-4-6', messages: [] }))

    const toolUses = chunks.filter((c) => c.type === 'tool_use')
    expect(toolUses).toHaveLength(1)
    // Should fall back to _raw
    expect(toolUses[0]!.toolUse!.input).toEqual({ _raw: 'not valid json' })
  })

  // ═══════════════════════════════════════════
  // chat — message conversion (multi-modal)
  // ═══════════════════════════════════════════

  it('should convert string content to text block array', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: {"type":"message_stop"}'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    await collectChunks(
      provider.chat({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    )

    const messages = capturedBody.messages as Array<{
      role: string
      content: Array<{ type: string }>
    }>
    expect(messages[0]!.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('should convert image blocks to Anthropic source format (base64)', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: {"type":"message_stop"}'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    await collectChunks(
      provider.chat({
        model: 'claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
        ],
      }),
    )

    const messages = capturedBody.messages as Array<{
      role: string
      content: Array<{ type: string; source?: Record<string, string> }>
    }>
    const imageBlock = messages[0]!.content[0]!
    expect(imageBlock.type).toBe('image')
    expect(imageBlock.source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: 'iVBORw0KGgo=',
    })
  })

  it('should convert regular URL images to source url format', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: {"type":"message_stop"}'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    await collectChunks(
      provider.chat({
        model: 'claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://example.com/photo.png' } }],
          },
        ],
      }),
    )

    const messages = capturedBody.messages as Array<{
      role: string
      content: Array<{ type: string; source?: { type: string; url: string } }>
    }>
    expect(messages[0]!.content[0]!.type).toBe('image')
    expect(messages[0]!.content[0]!.source!.type).toBe('url')
    expect(messages[0]!.content[0]!.source!.url).toBe('https://example.com/photo.png')
  })

  it('should convert tool_use blocks', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: {"type":"message_stop"}'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    await collectChunks(
      provider.chat({
        model: 'claude-sonnet-4-6',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'read',
                input: { file_path: '/tmp/x.ts' },
              },
            ],
          },
        ],
      }),
    )

    const messages = capturedBody.messages as Array<{
      role: string
      content: Array<{ type: string; id: string; name: string; input: unknown }>
    }>
    const toolUseBlock = messages[0]!.content[0]!
    expect(toolUseBlock.type).toBe('tool_use')
    expect(toolUseBlock.id).toBe('call_1')
    expect(toolUseBlock.input).toEqual({ file_path: '/tmp/x.ts' })
  })

  it('should convert tool_result blocks', async () => {
    let capturedBody: Record<string, unknown> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedBody = JSON.parse(opts.body as string)
      return makeSSEResponse(['data: {"type":"message_stop"}'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    await collectChunks(
      provider.chat({
        model: 'claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_1',
                content: 'file contents here',
              },
            ],
          },
        ],
      }),
    )

    const messages = capturedBody.messages as Array<{
      role: string
      content: Array<{ type: string; tool_use_id: string; content: string }>
    }>
    const resultBlock = messages[0]!.content[0]!
    expect(resultBlock.type).toBe('tool_result')
    expect(resultBlock.tool_use_id).toBe('call_1')
  })

  // ═══════════════════════════════════════════
  // chat — error handling
  // ═══════════════════════════════════════════

  it('should yield error on non-OK HTTP response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"error":{"message":"Invalid API key"}}', { status: 401 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    const chunks = await collectChunks(provider.chat({ model: 'claude-sonnet-4-6', messages: [] }))

    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.type).toBe('error')
    expect(chunks[0]!.error).toContain('401')
  })

  it('should yield error when response body is null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    const chunks = await collectChunks(provider.chat({ model: 'claude-sonnet-4-6', messages: [] }))

    expect(chunks[0]!.type).toBe('error')
  })

  it('should yield error on SSE error event', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeSSEResponse([
          'data: {"type":"error","error":{"type":"overloaded","message":"Server overloaded"}}',
        ]),
      )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    const chunks = await collectChunks(provider.chat({ model: 'claude-sonnet-4-6', messages: [] }))

    const errors = chunks.filter((c) => c.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.error).toBe('Server overloaded')
  })

  // ═══════════════════════════════════════════
  // API key resolution
  // ═══════════════════════════════════════════

  it('should resolve API key from env var', async () => {
    process.env.ANTHROPIC_KEY = 'sk-ant-env-key'
    let capturedHeaders: Record<string, string> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedHeaders = (opts.headers || {}) as Record<string, string>
      return makeSSEResponse(['data: {"type":"message_stop"}'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig({ apiKey: '${ANTHROPIC_KEY}' }))
    await collectChunks(provider.chat({ model: 'claude-sonnet-4-6', messages: [] }))

    expect(capturedHeaders['x-api-key']).toBe('sk-ant-env-key')
  })

  it('should use direct key when no env pattern', async () => {
    let capturedHeaders: Record<string, string> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedHeaders = (opts.headers || {}) as Record<string, string>
      return makeSSEResponse(['data: {"type":"message_stop"}'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig({ apiKey: 'sk-ant-direct' }))
    await collectChunks(provider.chat({ model: 'claude-sonnet-4-6', messages: [] }))

    expect(capturedHeaders['x-api-key']).toBe('sk-ant-direct')
  })

  it('should send anthropic-version header', async () => {
    let capturedHeaders: Record<string, string> = {}
    const fetchMock = vi.fn().mockImplementation(async (_url, opts) => {
      capturedHeaders = (opts.headers || {}) as Record<string, string>
      return makeSSEResponse(['data: {"type":"message_stop"}'])
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const provider = new AnthropicProvider(makeConfig())
    await collectChunks(provider.chat({ model: 'claude-sonnet-4-6', messages: [] }))

    expect(capturedHeaders['anthropic-version']).toBe('2023-06-01')
    expect(capturedHeaders['anthropic-beta']).toBe('prompt-caching-2024-07-31')
  })

  // ═══════════════════════════════════════════
  // listModels
  // ═══════════════════════════════════════════

  it('should list only active models', async () => {
    const provider = new AnthropicProvider(makeConfig())
    const models = await provider.listModels()

    expect(models).toHaveLength(2)
    expect(models.every((m) => m.status === 'active')).toBe(true)
  })

  it('should exclude deprecated models', async () => {
    const provider = new AnthropicProvider(makeConfig())
    const models = await provider.listModels()

    const deprecated = models.find((m) => m.id === 'claude-opus-4')
    expect(deprecated).toBeUndefined()
  })

  // ═══════════════════════════════════════════
  // healthCheck
  // ═══════════════════════════════════════════

  it('should return true for valid Anthropic key format', async () => {
    const provider = new AnthropicProvider(makeConfig({ apiKey: 'sk-ant-valid-key' }))
    const healthy = await provider.healthCheck()
    expect(healthy).toBe(true)
  })

  it('should return false for invalid key format', async () => {
    const provider = new AnthropicProvider(makeConfig({ apiKey: 'not-anthropic-key' }))
    const healthy = await provider.healthCheck()
    expect(healthy).toBe(false)
  })

  it('should return false for empty key', async () => {
    process.env.EMPTY_KEY = ''
    const provider = new AnthropicProvider(makeConfig({ apiKey: '${EMPTY_KEY}' }))
    const healthy = await provider.healthCheck()
    expect(healthy).toBe(false)
  })

  // ═══════════════════════════════════════════
  // Config
  // ═══════════════════════════════════════════

  it('should expose config via public property', () => {
    const config = makeConfig()
    const provider = new AnthropicProvider(config)
    expect(provider.config).toBe(config)
  })
})
