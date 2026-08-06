import { describe, it, expect, vi } from 'vitest'
import {
  buildRequest,
  sendInferenceCheck,
  isInferenceHookEnabled,
} from '../../src/core/inference-hook'
import type { InferenceHookConfig, Message } from '../../src/shared/types'

// ── Helpers ──

function makeConfig(overrides: Partial<InferenceHookConfig> = {}): InferenceHookConfig {
  return {
    endpoint: 'https://dlp.example.com/inspect',
    signing_secret: 'mis_testsecret12345678901234',
    timeout: 5000,
    on_failure: 'fail-closed',
    organization_id: 'org_test',
    headers: {},
    ...overrides,
  }
}

function makeMessages(): Message[] {
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello, my SSN is 123-45-6789' },
    {
      role: 'assistant',
      content: "I notice you've shared a number that looks like an SSN.",
    },
    {
      role: 'user',
      content: 'Can you read file.txt for me?',
    },
  ]
}

function makeMessagesWithToolCalls(): Message[] {
  return [
    { role: 'user', content: 'Read the secret file' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/secret.txt' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool_1',
          content: 'SECRET: API_KEY=sk-abc123',
        },
      ],
    },
    { role: 'user', content: 'Now summarize that' },
  ]
}

// ── Tests: buildRequest ──

describe('buildRequest', () => {
  it('should exclude system messages from the payload', () => {
    const messages = makeMessages()
    const request = buildRequest(messages, 'ses_1', 'anthropic', 'claude-sonnet-5')

    const hasSystem = request.data.messages.some((m) => m.role === 'system')
    expect(hasSystem).toBe(false)
  })

  it('should include user and assistant messages', () => {
    const messages = makeMessages()
    const request = buildRequest(messages, 'ses_1', 'anthropic', 'claude-sonnet-5')

    expect(request.data.messages).toHaveLength(3) // 2 user + 1 assistant (system excluded)
    expect(request.data.messages[0]!.role).toBe('user')
    expect(request.data.messages[1]!.role).toBe('assistant')
  })

  it('should set correct envelope fields', () => {
    const request = buildRequest(makeMessages(), 'ses_xyz', 'deepseek', 'deepseek-v4-pro', 'org_42')

    expect(request.type).toBe('inference_check')
    expect(request.id).toMatch(/^evt_/)
    expect(request.data.type).toBe('pre_inference')
    expect(request.data.session_id).toBe('ses_xyz')
    expect(request.data.provider).toBe('deepseek')
    expect(request.data.model).toBe('deepseek-v4-pro')
    expect(request.data.organization_id).toBe('org_42')
  })

  it('should omit organization_id when not provided', () => {
    const request = buildRequest(makeMessages(), 'ses_1', 'anthropic', 'claude-sonnet-5')

    expect(request.data.organization_id).toBeUndefined()
  })

  it('should extract tool calls with result previews', () => {
    const messages = makeMessagesWithToolCalls()
    const request = buildRequest(messages, 'ses_1', 'anthropic', 'claude-sonnet-5')

    expect(request.data.tool_calls).toHaveLength(1)
    expect(request.data.tool_calls[0]!.name).toBe('Read')
    expect(request.data.tool_calls[0]!.input).toEqual({ file_path: '/secret.txt' })
    expect(request.data.tool_calls[0]!.result_preview).toContain('SECRET')
  })

  it('should truncate result_preview to 2000 characters', () => {
    const longContent = 'x'.repeat(3000)
    const messages: Message[] = [
      { role: 'user', content: 'test' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/f' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: longContent }],
      },
    ]

    const request = buildRequest(messages, 'ses_1', 'a', 'm')
    expect(request.data.tool_calls[0]!.result_preview.length).toBeLessThanOrEqual(2000)
  })

  it('should handle messages with ContentBlock arrays', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'thinking', thinking: 'Hmm...' },
        ],
      },
    ]

    const request = buildRequest(messages, 'ses_1', 'a', 'm')
    expect(request.data.messages[0]!.content).toContain('Hello')
  })
})

// ── Tests: isInferenceHookEnabled ──

describe('isInferenceHookEnabled', () => {
  it('should return true when endpoint is set', () => {
    expect(isInferenceHookEnabled(makeConfig())).toBe(true)
  })

  it('should return false when endpoint is empty', () => {
    expect(isInferenceHookEnabled(makeConfig({ endpoint: '' }))).toBe(false)
  })

  it('should return false when config is undefined', () => {
    expect(isInferenceHookEnabled(undefined)).toBe(false)
  })
})

// ── Tests: sendInferenceCheck ──

describe('sendInferenceCheck', () => {
  it('should return allowed:true on HTTP 200 with allow verdict', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ verdict: 'allow' }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    const config = makeConfig()
    const request = buildRequest(makeMessages(), 's1', 'a', 'm')
    const verdict = await sendInferenceCheck(config, request)

    expect(verdict.allowed).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('should return allowed:false on HTTP 403 deny', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ verdict: 'deny', reason: 'SSN detected' }), {
        status: 403,
      }),
    )
    vi.stubGlobal('fetch', mockFetch)

    const config = makeConfig()
    const request = buildRequest(makeMessages(), 's1', 'a', 'm')
    const verdict = await sendInferenceCheck(config, request)

    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('SSN')
  })

  it('should include X-Mipham-Signature header when signing_secret is set', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ verdict: 'allow' }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)

    const config = makeConfig()
    const request = buildRequest(makeMessages(), 's1', 'a', 'm')
    await sendInferenceCheck(config, request)

    const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers['X-Mipham-Signature']).toMatch(/^t=\d+,v1=[a-f0-9]+$/)
  })

  it('should apply fail-closed on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')))

    const config = makeConfig({ on_failure: 'fail-closed' })
    const request = buildRequest(makeMessages(), 's1', 'a', 'm')
    const verdict = await sendInferenceCheck(config, request)

    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('unreachable')
  })

  it('should apply fail-open on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')))

    const config = makeConfig({ on_failure: 'fail-open' })
    const request = buildRequest(makeMessages(), 's1', 'a', 'm')
    const verdict = await sendInferenceCheck(config, request)

    expect(verdict.allowed).toBe(true)
  })

  it('should apply fail-closed on non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Internal error', { status: 500 })),
    )

    const config = makeConfig({ on_failure: 'fail-closed' })
    const request = buildRequest(makeMessages(), 's1', 'a', 'm')
    const verdict = await sendInferenceCheck(config, request)

    expect(verdict.allowed).toBe(false)
  })

  it('should apply fail-open on non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Internal error', { status: 500 })),
    )

    const config = makeConfig({ on_failure: 'fail-open' })
    const request = buildRequest(makeMessages(), 's1', 'a', 'm')
    const verdict = await sendInferenceCheck(config, request)

    expect(verdict.allowed).toBe(true)
  })
})
