import { describe, it, expect, vi } from 'vitest'
import type { ProviderConfig, StreamChunk } from '@mipham/shared'
import { AnthropicProvider } from '../../src/providers/anthropic'
import { OpenAICompatProvider } from '../../src/providers/openai-compat'

/**
 * The reader owns the connection, and the consumer is allowed to walk away.
 *
 * `engine.ts` breaks out of the provider generator on the ordinary `stop` chunk,
 * and a sub-agent throws mid-stream when it is aborted. Both call the generator's
 * `.return()`, which unwinds its `finally` — but until there was one, nothing
 * cancelled `response.body`, so the socket stayed open and could not be reused.
 *
 * The probe stream deliberately never closes. Cancelling an already-closed stream
 * is a spec no-op (`ReadableStreamCancel` returns early without touching the
 * source), so a closed probe would make these assertions unreachable — the
 * recorder would never fire even with the fix in place. A stream that is still
 * open is both the only shape that can observe the cancel and the shape that
 * happens in production when the consumer stops early.
 */

interface Probe {
  response: Response
  cancelled: () => boolean
}

function openSSE(lines: string[]): Probe {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // One chunk, then nothing. The stream is left open on purpose — see above.
      controller.enqueue(new TextEncoder().encode(lines.join('\n') + '\n'))
    },
    cancel() {
      cancelled = true
    },
  })
  return { response: new Response(body, { status: 200 }), cancelled: () => cancelled }
}

function openaiConfig(): ProviderConfig {
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
    ],
  }
}

function anthropicConfig(): ProviderConfig {
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
    ],
  }
}

/** Consume until `stop` (not to the end of the stream), mirroring `engine.ts`. */
async function untilStop(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const seen: StreamChunk[] = []
  for await (const c of gen) {
    seen.push(c)
    if (c.type === 'stop') break
  }
  return seen
}

/** Leave mid-stream, mirroring an aborted sub-agent. */
async function quitAfterFirst(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const seen: StreamChunk[] = []
  for await (const c of gen) {
    seen.push(c)
    break
  }
  return seen
}

const openaiStop = [
  'data: {"choices":[{"delta":{"content":"hi"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
]

const anthropicStop = [
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
  'data: {"type":"message_stop"}',
]

describe('openai-compat: the body is cancelled when the consumer stops early', () => {
  it('cancels when the consumer breaks on the stop chunk', async () => {
    const probe = openSSE(openaiStop)
    globalThis.fetch = vi.fn().mockResolvedValue(probe.response) as unknown as typeof fetch

    const seen = await untilStop(
      new OpenAICompatProvider(openaiConfig()).chat({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )

    expect(seen.map((c) => c.type)).toEqual(['text', 'stop'])
    expect(probe.cancelled()).toBe(true)
  })

  it('cancels when the consumer walks away mid-stream', async () => {
    const probe = openSSE(openaiStop)
    globalThis.fetch = vi.fn().mockResolvedValue(probe.response) as unknown as typeof fetch

    await quitAfterFirst(
      new OpenAICompatProvider(openaiConfig()).chat({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )

    expect(probe.cancelled()).toBe(true)
  })

  it('cancels on the [DONE] exit, which returns from inside the loop', async () => {
    const probe = openSSE(['data: {"choices":[{"delta":{"content":"hi"}}]}', 'data: [DONE]'])
    globalThis.fetch = vi.fn().mockResolvedValue(probe.response) as unknown as typeof fetch

    const chunks: StreamChunk[] = []
    for await (const c of new OpenAICompatProvider(openaiConfig()).chat({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(c)
    }

    expect(chunks.filter((c) => c.type === 'stop')).toHaveLength(1)
    expect(probe.cancelled()).toBe(true)
  })
})

describe('anthropic: the body is cancelled when the consumer stops early', () => {
  it('cancels when the consumer breaks on the stop chunk', async () => {
    const probe = openSSE(anthropicStop)
    globalThis.fetch = vi.fn().mockResolvedValue(probe.response) as unknown as typeof fetch

    const seen = await untilStop(
      new AnthropicProvider(anthropicConfig()).chat({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )

    expect(seen.map((c) => c.type)).toEqual(['text', 'stop'])
    expect(probe.cancelled()).toBe(true)
  })

  it('cancels when the consumer walks away mid-stream', async () => {
    const probe = openSSE(anthropicStop)
    globalThis.fetch = vi.fn().mockResolvedValue(probe.response) as unknown as typeof fetch

    await quitAfterFirst(
      new AnthropicProvider(anthropicConfig()).chat({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )

    expect(probe.cancelled()).toBe(true)
  })
})

describe('a stream that runs out on its own is unchanged', () => {
  // The counterpart to the probes above: a stream that closes is consumed to the
  // end, and the trailing stop still arrives. Without this, a fix that cancelled
  // too eagerly (or swallowed the tail) would look identical on the probes.
  function closingSSE(lines: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(lines.join('\n') + '\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200 })
  }

  it('openai-compat still emits its trailing stop', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        closingSSE(['data: {"choices":[{"delta":{"content":"hi"}}]}']),
      ) as unknown as typeof fetch

    const chunks: StreamChunk[] = []
    for await (const c of new OpenAICompatProvider(openaiConfig()).chat({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(c)
    }

    expect(chunks.map((c) => c.type)).toEqual(['text', 'stop'])
  })

  it('anthropic still reports a stream with no terminal event as truncated', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        closingSSE([
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
        ]),
      ) as unknown as typeof fetch

    const chunks: StreamChunk[] = []
    for await (const c of new AnthropicProvider(anthropicConfig()).chat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(c)
    }

    expect(chunks.filter((c) => c.type === 'stop')[0]!.truncated).toBe(true)
  })
})
