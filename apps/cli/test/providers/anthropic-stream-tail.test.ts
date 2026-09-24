import { describe, it, expect, vi } from 'vitest'
import type { ProviderConfig, StreamChunk } from '@mipham/shared'
import { AnthropicProvider } from '../../src/providers/anthropic'

/**
 * The end of a stream is where a cut response and a finished one look alike.
 *
 * `truncated` was latched when `stop_reason: max_tokens` arrived, but the stop
 * that the provider emits when the stream simply *ends* — no `message_stop`, the
 * shape a proxy or gateway closing the connection cleanly produces — did not
 * carry it. The latch survived to the end of the function and was dropped there,
 * so a turn cut off at the output ceiling and a turn cut off by a proxy both came
 * out as a plain stop: indistinguishable from `end_turn`.
 *
 * A stream that never reached its terminal event is incomplete whatever stopped
 * it, and a replayed block is not a second call.
 */

function makeConfig(): ProviderConfig {
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

function makeSSEResponse(lines: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines.join('\n') + '\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

async function run(lines: string[]): Promise<StreamChunk[]> {
  globalThis.fetch = vi.fn().mockResolvedValue(makeSSEResponse(lines)) as unknown as typeof fetch
  const provider = new AnthropicProvider(makeConfig())
  const chunks: StreamChunk[] = []
  for await (const c of provider.chat({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    chunks.push(c)
  }
  return chunks
}

const stopOf = (chunks: StreamChunk[]): StreamChunk =>
  chunks.filter((c) => c.type === 'stop').pop()!

const TEXT_DELTA =
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}'

describe('a stream that ends without its terminal event', () => {
  it('is not reported as a clean finish', async () => {
    const chunks = await run([TEXT_DELTA])

    expect(stopOf(chunks).truncated).toBe(true)
  })

  it('is not cleared by a trailing usage-only frame', async () => {
    // A gateway may report usage in a frame of its own, with no `stop_reason` in
    // it. Reading every `message_delta` as "the stop reason" would erase the
    // ceiling the previous frame reported — it has to be latched, not overwritten.
    const chunks = await run([
      TEXT_DELTA,
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":12}}',
      'data: {"type":"message_delta","usage":{"output_tokens":12}}',
      'data: {"type":"message_stop"}',
    ])

    expect(stopOf(chunks).truncated).toBe(true)
  })

  it('does not invent truncation out of a usage-only frame', async () => {
    const chunks = await run([
      TEXT_DELTA,
      'data: {"type":"message_delta","usage":{"output_tokens":3}}',
      'data: {"type":"message_stop"}',
    ])

    expect(stopOf(chunks).truncated).toBeUndefined()
  })

  it('still reports a complete turn as complete', async () => {
    const chunks = await run([
      TEXT_DELTA,
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      'data: {"type":"message_stop"}',
    ])

    expect(stopOf(chunks).truncated).toBeUndefined()
  })

  it('still reports a turn that hit the ceiling as truncated', async () => {
    const chunks = await run([
      TEXT_DELTA,
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
      'data: {"type":"message_stop"}',
    ])

    expect(stopOf(chunks).truncated).toBe(true)
  })
})

describe('a replayed block is one call, not two', () => {
  const call = (id: string, name: string, input: string) => [
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"${id}","name":"${name}"}}`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(input)}}}`,
    'data: {"type":"content_block_stop","index":0}',
  ]

  it('emits one tool call when the stream delivers the block twice', async () => {
    // A proxy replaying an event makes the engine execute the tool twice — two
    // writes, two commits, two of whatever the tool does.
    const chunks = await run([
      ...call('toolu_a', 'read', '{"file":"x"}'),
      ...call('toolu_a', 'read', '{"file":"x"}'),
      'data: {"type":"message_stop"}',
    ])

    const calls = chunks.filter((c) => c.type === 'tool_use')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.toolUse!.id).toBe('toolu_a')
  })

  it('emits both calls when two different blocks arrive', async () => {
    const chunks = await run([
      ...call('toolu_a', 'read', '{"file":"x"}'),
      ...call('toolu_b', 'bash', '{"command":"ls"}'),
      'data: {"type":"message_stop"}',
    ])

    const ids = chunks.filter((c) => c.type === 'tool_use').map((c) => c.toolUse!.id)
    expect(ids).toEqual(['toolu_a', 'toolu_b'])
  })
})
