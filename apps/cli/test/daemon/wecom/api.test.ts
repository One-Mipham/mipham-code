import { describe, it, expect, afterEach, vi } from 'vitest'
import { createWecomApi } from '../../../src/daemon/wecom/api.js'

class MockWS {
  static instances: MockWS[] = []
  sent: string[] = []
  constructor(_url: string) {
    MockWS.instances.push(this)
  }
  send(d: string) {
    this.sent.push(d)
  }
}

afterEach(() => {
  MockWS.instances = []
  vi.unstubAllGlobals()
})

function stubWs() {
  vi.stubGlobal('WebSocket', MockWS as any)
  const api = createWecomApi({ botId: 'b', botSecret: 's', allowedUserIds: [] })
  const ws = api.open()
  return { api, ws }
}

describe('createWecomApi', () => {
  it('open 建连到官方 wss 端点', () => {
    const { ws } = stubWs()
    expect(MockWS.instances[0]).toBe(ws as any)
  })

  it('subscribe 发送 aibot_subscribe + bot_id/secret', () => {
    const { api, ws } = stubWs()
    api.subscribe(ws)
    const frame = JSON.parse((ws as any).sent[0])
    expect(frame.cmd).toBe('aibot_subscribe')
    expect(frame.body).toMatchObject({ bot_id: 'b', bot_secret: 's' })
  })

  it('ping 发送 ping 帧', () => {
    const { api, ws } = stubWs()
    api.ping(ws)
    expect(JSON.parse((ws as any).sent[0]).cmd).toBe('ping')
  })

  it('attach 后 respond 发送 aibot_respond_msg + 文本', () => {
    const { api, ws } = stubWs()
    api.attach(ws)
    api.respond('alice', 'hello')
    const frame = JSON.parse((ws as any).sent[0])
    expect(frame.cmd).toBe('aibot_respond_msg')
    expect(JSON.stringify(frame)).toContain('hello')
  })

  it('未 attach → respond 静默 no-op', () => {
    const { api } = stubWs()
    expect(() => api.respond('alice', 'hello')).not.toThrow()
  })

  it('parseMessage 解析 aibot_msg_callback → WecomMessage', () => {
    const { api } = stubWs()
    const m = api.parseMessage({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'r1' },
      body: { userid: 'alice', chatid: 'c1', msg_id: 'm1', content: 'hi' },
    })
    expect(m).toEqual({ userId: 'alice', chatId: 'c1', msgId: 'm1', text: 'hi' })
  })

  it('parseMessage 非消息帧 → null', () => {
    const { api } = stubWs()
    expect(api.parseMessage({ cmd: 'enter_chat' })).toBeNull()
    expect(api.parseMessage({})).toBeNull()
  })

  it('isDisconnected 识别 disconnected_event', () => {
    const { api } = stubWs()
    expect(api.isDisconnected({ cmd: 'disconnected_event' })).toBe(true)
    expect(api.isDisconnected({ cmd: 'aibot_msg_callback' })).toBe(false)
  })
})
