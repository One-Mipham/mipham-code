import { describe, it, expect, vi, afterEach } from 'vitest'
import { createWecomAdapter } from '../../../src/daemon/wecom/adapter.js'

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
  emitOpen() {
    this.onopen?.()
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

describe('wecom 集成（ws-client → adapter → 回发）', () => {
  it('一条消息回调端到端触发 prompt + respond', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', MockWS as any)

    const deps = makeDeps()
    const respond = vi.fn()
    const api = {
      open: () => new MockWS('x'),
      subscribe: vi.fn(),
      ping: vi.fn(),
      respond,
      parseMessage: (f: any) =>
        f.cmd === 'aibot_msg_callback'
          ? { userId: 'alice', chatId: 'c1', msgId: 'm1', text: f.body.content }
          : null,
      isDisconnected: (f: any) => f.cmd === 'disconnected_event',
      attach: vi.fn(),
    } as any

    const adapter = createWecomAdapter(
      { botId: 'b', botSecret: 's', allowedUserIds: ['alice'] },
      api,
      deps,
    )
    const stop = adapter.start()
    const ws = MockWS.instances[0]!
    ws.emitOpen()
    ws.emitMessage({ cmd: 'aibot_msg_callback', body: { content: 'hi' } })

    await vi.waitFor(() => expect(deps.processPrompt).toHaveBeenCalledWith('hi'))
    stop()
  })
})
