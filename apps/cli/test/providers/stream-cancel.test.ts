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

/**
 * The caller's signal has to reach the transport — and handing it over must not
 * abort it.
 *
 * `ChatRequest.signal` was declared (`registry.ts:19`), read by `fetch-utils`,
 * and set by `self-critique` (its 2-second critique budget) — but neither
 * provider put it in its request init, so `init.signal` was always `undefined`
 * and that budget could never fire. Two halves, failing in **opposite**
 * directions, so both are pinned here:
 *
 *  ① forward it — without this, aborting the caller's controller does nothing,
 *    and the turn completes as if nobody had left;
 *  ② don't abort it on the way out — `fetchWithRetry`'s cleanup aborted the
 *    combined signal it had just handed to `fetch`. Since the caller reads the
 *    body *after* that, it kills the response: measured, Node's next read throws
 *    `AbortError` (Bun tolerates it, which is why this survived a Bun-only run).
 *    A probe that only checked ① stays green with ② broken — hence the
 *    unaborted control below, which is the test that actually catches ②.
 */
function signalProbe(sseLines: string[]): {
  fetchMock: typeof fetch
  signal: () => AbortSignal | undefined
} {
  let seen: AbortSignal | undefined
  const encoder = new TextEncoder()
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      ctrl = c
      // Fed slowly on purpose: the abort has to land while the stream is still
      // in flight, which is the shape production has (a live SSE response).
      for (const line of sseLines) {
        await new Promise((r) => setTimeout(r, 3))
        try {
          c.enqueue(encoder.encode(line + '\n'))
        } catch {
          return // already errored by the abort — nothing left to feed
        }
      }
      try {
        c.close()
      } catch {
        /* already errored */
      }
    },
    cancel() {},
  })

  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    seen = init?.signal ?? undefined
    // Mirror the spec (and the measured Node behaviour): an aborted signal
    // errors this body, so a reader that is already attached sees a rejection.
    seen?.addEventListener('abort', () => {
      try {
        ctrl.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
      } catch {
        /* stream already closed or errored */
      }
    })
    return Promise.resolve(new Response(body, { status: 200 }))
  }) as unknown as typeof fetch

  return { fetchMock, signal: () => seen }
}

const openaiFive = [
  'data: {"choices":[{"delta":{"content":"1"}}]}',
  'data: {"choices":[{"delta":{"content":"2"}}]}',
  'data: {"choices":[{"delta":{"content":"3"}}]}',
  'data: {"choices":[{"delta":{"content":"4"}}]}',
  'data: {"choices":[{"delta":{"content":"5"}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
]

const anthropicFive = [
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"1"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"2"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"3"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"4"}}',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"5"}}',
  'data: {"type":"message_stop"}',
]

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

describe('调用方撤销时这条流真的会断（signal 送达传输层，D17）', () => {
  it('openai-compat：撤销 ⇒ 流当场断掉，而不是照常读完', async () => {
    const probe = signalProbe(openaiFive)
    globalThis.fetch = probe.fetchMock

    const ac = new AbortController()
    const gen = new OpenAICompatProvider(openaiConfig()).chat({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ac.signal,
    })

    const seen: StreamChunk[] = []
    for await (const c of gen) {
      seen.push(c)
      if (c.type === 'text') ac.abort() // 用户在第 1 块之后走人
    }

    // 「调用方的撤销到达了传输层」——单看「fetch 收到了某个 signal」没有分辨力：
    // `fetch-utils` 无论 `init.signal` 在不在都会塞一个自己的超时 signal 进去。
    expect(probe.signal()?.aborted).toBe(true)
    expect(seen.filter((c) => c.type === 'text').length).toBeLessThan(5)
    expect(seen.some((c) => c.type === 'stop')).toBe(false)
  })

  it('anthropic：撤销 ⇒ 流当场断掉，而不是照常读完', async () => {
    const probe = signalProbe(anthropicFive)
    globalThis.fetch = probe.fetchMock

    const ac = new AbortController()
    const gen = new AnthropicProvider(anthropicConfig()).chat({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ac.signal,
    })

    const seen: StreamChunk[] = []
    for await (const c of gen) {
      seen.push(c)
      if (c.type === 'text') ac.abort()
    }

    expect(probe.signal()?.aborted).toBe(true)
    expect(seen.filter((c) => c.type === 'text').length).toBeLessThan(5)
    expect(seen.some((c) => c.type === 'stop')).toBe(false)
  })

  it('openai-compat：不撤销 ⇒ 照常读完（钉住「交出去时不许撤销」）', async () => {
    const probe = signalProbe(openaiFive)
    globalThis.fetch = probe.fetchMock

    const ac = new AbortController() // 永不撤销
    const seen = await collect(
      new OpenAICompatProvider(openaiConfig()).chat({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
        signal: ac.signal,
      }),
    )

    // ② 的根因判据：交出去之后没有任何人以任何理由撤销它。这一条比块数更直接 ——
    // 块数是「body 被杀」的结果，这里是「谁杀了它」本身。
    expect(probe.signal()?.aborted).toBe(false)
    expect(seen.filter((c) => c.type === 'text').length).toBe(5)
    expect(seen.some((c) => c.type === 'stop')).toBe(true)
  })

  it('anthropic：不撤销 ⇒ 照常读完（钉住「交出去时不许撤销」）', async () => {
    const probe = signalProbe(anthropicFive)
    globalThis.fetch = probe.fetchMock

    const ac = new AbortController() // 永不撤销
    const seen = await collect(
      new AnthropicProvider(anthropicConfig()).chat({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        signal: ac.signal,
      }),
    )

    // ② 的根因判据：交出去之后没有任何人以任何理由撤销它。这一条比块数更直接 ——
    // 块数是「body 被杀」的结果，这里是「谁杀了它」本身。
    expect(probe.signal()?.aborted).toBe(false)
    expect(seen.filter((c) => c.type === 'text').length).toBe(5)
    expect(seen.some((c) => c.type === 'stop')).toBe(true)
  })
})
