import { describe, it, expect, vi, afterEach } from 'vitest'
import { nextBackoff, startDingtalkWs } from '../../../src/daemon/dingtalk/ws-client.js'

describe('nextBackoff', () => {
  it('指数退避', () => expect(nextBackoff(1000)).toBe(2000))
  it('封顶 30s', () => expect(nextBackoff(20000)).toBe(30000))
})

class MockWS {
  static instances: MockWS[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  constructor(_url: string) {
    MockWS.instances.push(this)
  }
  close() {
    this.closed = true
    this.onclose?.()
  }
  emitMessage(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

function makeApi() {
  return {
    register: vi.fn(async () => ({ endpoint: 'wss://x/connect', ticket: 't1' })),
    open: vi.fn((endpoint: string, ticket: string) => new MockWS(`${endpoint}?ticket=${ticket}`)),
    reply: vi.fn(async () => {}),
    parseMessage: (f: any) =>
      f.type === 'CALLBACK'
        ? {
            staffId: 'alice',
            conversationId: 'c1',
            msgId: 'm1',
            text: 'hi',
            sessionWebhook: 'https://x',
          }
        : null,
    isPing: (f: any) => f.type === 'SYSTEM' && f.headers?.topic === 'ping',
    ack: vi.fn(),
    pong: vi.fn(),
  } as any
}

afterEach(() => {
  MockWS.instances = []
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('startDingtalkWs', () => {
  it('register 后 open 建连（ticket 拼进 URL）', async () => {
    const api = makeApi()
    const stop = startDingtalkWs(
      api,
      vi.fn(async () => {}),
    )
    await vi.waitFor(() => expect(MockWS.instances.length).toBe(1))
    expect(api.register).toHaveBeenCalledTimes(1)
    expect(api.open).toHaveBeenCalledWith('wss://x/connect', 't1')
    stop()
  })

  it('CALLBACK → ack + onMessage', async () => {
    const api = makeApi()
    const onMessage = vi.fn(async () => {})
    const stop = startDingtalkWs(api, onMessage)
    await vi.waitFor(() => expect(MockWS.instances.length).toBe(1))
    const ws = MockWS.instances[0]!
    ws.emitMessage({ type: 'CALLBACK', headers: { messageId: 'cb-1' }, data: '{}' })
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1))
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'hi' }))
    expect(api.ack).toHaveBeenCalledWith(ws, expect.objectContaining({ type: 'CALLBACK' }))
    stop()
  })

  it('SYSTEM ping → pong（不触发 onMessage）', async () => {
    const api = makeApi()
    const onMessage = vi.fn(async () => {})
    const stop = startDingtalkWs(api, onMessage)
    await vi.waitFor(() => expect(MockWS.instances.length).toBe(1))
    const ws = MockWS.instances[0]!
    ws.emitMessage({ type: 'SYSTEM', headers: { topic: 'ping', messageId: 'sys-1' }, data: {} })
    await vi.waitFor(() => expect(api.pong).toHaveBeenCalledTimes(1))
    expect(onMessage).not.toHaveBeenCalled()
    stop()
  })

  it('register 失败 → 退避后重试', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    api.register.mockRejectedValueOnce(new Error('boom'))
    const stop = startDingtalkWs(
      api,
      vi.fn(async () => {}),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(MockWS.instances.length).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.register).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(MockWS.instances.length).toBe(1)
    stop()
  })

  it('onclose → 退避重连（重新 register）', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const stop = startDingtalkWs(
      api,
      vi.fn(async () => {}),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(MockWS.instances.length).toBe(1)
    const ws = MockWS.instances[0]!
    ws.onclose?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.register).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(MockWS.instances.length).toBe(2)
    stop()
  })

  it('stop → 停止重连', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const stop = startDingtalkWs(
      api,
      vi.fn(async () => {}),
    )
    await vi.advanceTimersByTimeAsync(0)
    const ws = MockWS.instances[0]!
    stop()
    ws.onclose?.()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(MockWS.instances.length).toBe(1) // stop 后不重连
  })
})
