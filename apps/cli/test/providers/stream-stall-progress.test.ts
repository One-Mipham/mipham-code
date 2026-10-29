import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ProviderConfig, StreamChunk } from '@mipham/shared'
import { OpenAICompatProvider } from '../../src/providers/openai-compat'
import { AnthropicProvider } from '../../src/providers/anthropic'
import { streamIdleTimeoutMs } from '../../src/providers/fetch-utils'

/**
 * The stall guard has to measure *progress*, not *bytes*.
 *
 * It used to be armed per `reader.read()`: any byte at all restarted the budget.
 * A gateway that keeps the connection warm while the answer never starts —
 * an SSE comment frame, or the API's own `ping` every ~30s — therefore fed the
 * guard forever, and the turn waited with no bound at all (measured: 12s of
 * keep-alives against a 2s budget, and not one timeout).
 *
 * So the probes below hold the *socket* busy and the *answer* silent. The
 * counterparts are the other half of the claim: a stream that is slow but keeps
 * producing content must survive well past the budget.
 */

function tickingSSE(frame: string, everyMs = 10_000): Response {
  let ticker: ReturnType<typeof setInterval> | undefined
  const stop = () => clearInterval(ticker)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (): void => {
        try {
          controller.enqueue(new TextEncoder().encode(frame))
        } catch {
          // The provider cancelled the reader (it gave up on the stall). The
          // socket is gone; a live ticker here would throw from a timer callback.
          stop()
        }
      }
      send()
      // The stream is never closed by the server: a live connection that stalls.
      ticker = setInterval(send, everyMs)
    },
    cancel: stop,
  })
  return new Response(body, { status: 200 })
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

/** Run `gen` under fake time and collect whatever it produced inside the window. */
async function collectFor(
  gen: AsyncGenerator<StreamChunk>,
  windowMs: number,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  const done = (async () => {
    for await (const c of gen) chunks.push(c)
  })()
  await vi.advanceTimersByTimeAsync(windowMs)
  void done
  return chunks
}

const BUDGET = streamIdleTimeoutMs()
const WINDOW = BUDGET * 3

describe('a keep-alive-fed stream still stalls', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('openai-compat: SSE comment frames do not keep a silent answer alive', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    })
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(tickingSSE(': keep-alive\n\n')) as unknown as typeof fetch

    const chunks = await collectFor(
      new OpenAICompatProvider(openaiConfig()).chat({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      WINDOW,
    )

    expect(chunks.map((c) => c.type)).toContain('error')
  })

  it('anthropic: ping frames do not keep a silent answer alive', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    })
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(tickingSSE('data: {"type":"ping"}\n\n')) as unknown as typeof fetch

    const chunks = await collectFor(
      new AnthropicProvider(anthropicConfig()).chat({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      WINDOW,
    )

    expect(chunks.map((c) => c.type)).toContain('error')
  })
})

describe('a slow but productive stream survives', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('openai-compat: content deltas every 10s outlive three budgets', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    })
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        tickingSSE('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'),
      ) as unknown as typeof fetch

    const chunks = await collectFor(
      new OpenAICompatProvider(openaiConfig()).chat({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      WINDOW,
    )

    expect(chunks.some((c) => c.type === 'error')).toBe(false)
    expect(chunks.filter((c) => c.type === 'text').length).toBeGreaterThan(3)
  })

  it('anthropic: content deltas every 10s outlive three budgets', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    })
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        tickingSSE(
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n',
        ),
      ) as unknown as typeof fetch

    const chunks = await collectFor(
      new AnthropicProvider(anthropicConfig()).chat({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      WINDOW,
    )

    expect(chunks.some((c) => c.type === 'error')).toBe(false)
    expect(chunks.filter((c) => c.type === 'text').length).toBeGreaterThan(3)
  })
})
