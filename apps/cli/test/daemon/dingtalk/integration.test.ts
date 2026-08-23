import { describe, it, expect, vi, afterEach } from 'vitest'
import { createDingtalkAdapter } from '../../../src/daemon/dingtalk/adapter.js'

vi.spyOn(console, 'error').mockImplementation(() => {})

class MockWS {
  static instances: MockWS[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  constructor(_url: string) {
    MockWS.instances.push(this)
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.onclose?.()
  }
  emitMessage(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

function makeDeps() {
  const processPrompt = vi.fn(async () => {})
  return {
    processPrompt,
    sm: { getOrCreateByExternalUser: vi.fn(() => ({ id: 'sess-1' })) } as any,
    getOrCreateWorker: vi.fn(() => ({
      processPrompt,
      getLastAssistantContent: () => 'done',
    })) as any,
    rateLimiter: { check: vi.fn(() => ({ allowed: true })) } as any,
    cwd: '/tmp',
    provider: 'anthropic',
    model: 'claude',
  }
}

afterEach(() => {
  MockWS.instances = []
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('dingtalk 集成（ws-client → adapter → sessionWebhook 回发）', () => {
  it('一条消息回调端到端触发 prompt + reply + ack', async () => {
    vi.stubGlobal('WebSocket', MockWS as any)

    const deps = makeDeps()
    const reply = vi.fn(async () => {})
    const api = {
      register: vi.fn(async () => ({ endpoint: 'wss://x/connect', ticket: 't1' })),
      open: (endpoint: string, ticket: string) => new MockWS(`${endpoint}?ticket=${ticket}`),
      reply,
      parseMessage: (f: any) =>
        f.type === 'CALLBACK'
          ? {
              staffId: 'alice',
              conversationId: 'c1',
              msgId: 'm1',
              text: 'hi',
              sessionWebhook: 'https://x/sendBySession/abc',
            }
          : null,
      isPing: (f: any) => f.type === 'SYSTEM' && f.headers?.topic === 'ping',
      ack: vi.fn(),
      pong: vi.fn(),
    } as any

    const adapter = createDingtalkAdapter(
      { clientId: 'id', clientSecret: 'secret', allowedStaffIds: ['alice'] },
      api,
      deps,
    )
    const stop = adapter.start()
    await vi.waitFor(() => expect(MockWS.instances.length).toBe(1))
    const ws = MockWS.instances[0]!
    ws.emitMessage({ type: 'CALLBACK', headers: { messageId: 'cb-1' }, data: '{}' })

    await vi.waitFor(() => expect(deps.processPrompt).toHaveBeenCalledWith('hi'))
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith('https://x/sendBySession/abc', 'done'),
    )
    expect(api.ack).toHaveBeenCalled()
    stop()
  })
})
