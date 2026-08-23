import { describe, it, expect, vi, afterEach } from 'vitest'
import { startWecomWs } from '../../../src/daemon/wecom/ws-client.js'

class MockWS {
  static instances: MockWS[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  closed = false
  constructor(_url: string) {
    MockWS.instances.push(this)
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.closed = true
    this.onclose?.()
  }
  emitOpen() {
    this.onopen?.()
  }
  emitMessage(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

function makeApi() {
  return {
    open: () => new MockWS('x'),
    subscribe: vi.fn(),
    ping: vi.fn(),
    attach: vi.fn(),
    respond: vi.fn(),
    parseMessage: (f: any) =>
      f.cmd === 'aibot_msg_callback'
        ? { userId: 'alice', chatId: 'c1', msgId: 'm1', text: f.body.content }
        : null,
    isDisconnected: (f: any) => f.cmd === 'disconnected_event',
  } as any
}

afterEach(() => {
  MockWS.instances = []
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('startWecomWs', () => {
  it('onopen → 发 subscribe', () => {
    vi.useFakeTimers()
    const api = makeApi()
    const stop = startWecomWs(
      api,
      vi.fn(async () => {}),
    )
    const ws = MockWS.instances[0]!
    ws.emitOpen()
    expect(api.subscribe).toHaveBeenCalledWith(ws)
    stop()
  })

  it('aibot_msg_callback → onMessage 调用', () => {
    vi.useFakeTimers()
    const api = makeApi()
    const onMessage = vi.fn(async () => {})
    const stop = startWecomWs(api, onMessage)
    const ws = MockWS.instances[0]!
    ws.emitOpen()
    ws.emitMessage({ cmd: 'aibot_msg_callback', body: { content: 'hi' } })
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'hi' }))
    stop()
  })

  it('心跳定时器每 30s 发 ping', () => {
    vi.useFakeTimers()
    const api = makeApi()
    const stop = startWecomWs(
      api,
      vi.fn(async () => {}),
    )
    const ws = MockWS.instances[0]!
    ws.emitOpen()
    vi.advanceTimersByTime(30_000)
    expect(api.ping).toHaveBeenCalledWith(ws)
    stop()
  })

  it('disconnected_event → 主动 close 不重连', () => {
    vi.useFakeTimers()
    const api = makeApi()
    const stop = startWecomWs(
      api,
      vi.fn(async () => {}),
    )
    const ws = MockWS.instances[0]!
    ws.emitOpen()
    ws.emitMessage({ cmd: 'disconnected_event' })
    expect(ws.closed).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(MockWS.instances.length).toBe(1) // 未重连
    stop()
  })

  it('onclose → 指数退避重连', () => {
    vi.useFakeTimers()
    const api = makeApi()
    const stop = startWecomWs(
      api,
      vi.fn(async () => {}),
    )
    const ws = MockWS.instances[0]!
    ws.emitOpen()
    ws.onclose?.() // 模拟服务端断开（非 disconnected_event）
    vi.advanceTimersByTime(1_000)
    expect(MockWS.instances.length).toBe(2) // 1s 后重连
    stop()
  })

  it('stop → 停止重连 + 清定时器', () => {
    vi.useFakeTimers()
    const api = makeApi()
    const stop = startWecomWs(
      api,
      vi.fn(async () => {}),
    )
    const ws = MockWS.instances[0]!
    ws.emitOpen()
    stop()
    ws.onclose?.()
    vi.advanceTimersByTime(60_000)
    expect(MockWS.instances.length).toBe(1) // stop 后不重连
  })
})
