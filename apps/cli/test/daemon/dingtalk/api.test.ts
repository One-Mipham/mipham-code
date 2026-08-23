import { describe, it, expect, vi, afterEach } from 'vitest'
import { createDingtalkApi } from '../../../src/daemon/dingtalk/api.js'

const fetchMock = vi.fn()
afterEach(() => vi.unstubAllGlobals())

function stubFetch(json: unknown, ok = true) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(json), { status: ok ? 200 : 500 }))
  vi.stubGlobal('fetch', fetchMock)
}

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

function makeApi() {
  vi.stubGlobal('WebSocket', MockWS as any)
  return createDingtalkApi({ clientId: 'id', clientSecret: 'secret', allowedStaffIds: [] })
}

afterEach(() => {
  MockWS.instances = []
})

describe('createDingtalkApi.register', () => {
  it('POST gateway + 返回 endpoint/ticket', async () => {
    stubFetch({ endpoint: 'wss://x/connect', ticket: 't1' })
    const api = makeApi()
    await expect(api.register()).resolves.toEqual({ endpoint: 'wss://x/connect', ticket: 't1' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toContain('/v1.0/gateway/connections/open')
    expect((init as RequestInit).method).toBe('POST')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.clientId).toBe('id')
    expect(body.subscriptions).toEqual([{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }])
  })

  it('非 ok → 抛错', async () => {
    stubFetch({}, false)
    const api = makeApi()
    await expect(api.register()).rejects.toThrow('register 500')
  })

  it('缺 endpoint/ticket → 抛错', async () => {
    stubFetch({ endpoint: 'wss://x/connect' })
    const api = makeApi()
    await expect(api.register()).rejects.toThrow('missing endpoint/ticket')
  })
})

describe('createDingtalkApi.open', () => {
  it('拼 ?ticket=（URL 编码）', () => {
    const api = makeApi()
    api.open('wss://x/connect', 'a+b/c=')
    expect(MockWS.instances.length).toBe(1)
  })
})

describe('createDingtalkApi.reply', () => {
  it('POST sessionWebhook + text body', async () => {
    stubFetch({ errcode: 0 })
    const api = makeApi()
    await api.reply('https://oapi.dingtalk.com/robot/sendBySession/abc', 'hi')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://oapi.dingtalk.com/robot/sendBySession/abc')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      msgtype: 'text',
      text: { content: 'hi' },
    })
  })

  it('errcode != 0 → 抛错', async () => {
    stubFetch({ errcode: 40014, errmsg: 'invalid token' })
    const api = makeApi()
    await expect(api.reply('https://x', 'hi')).rejects.toThrow('errcode=40014')
  })

  it('空 sessionWebhook → 静默 no-op', async () => {
    const api = makeApi()
    await expect(api.reply('', 'hi')).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('createDingtalkApi.parseMessage', () => {
  it('CALLBACK + data JSON 字符串 → DingtalkMessage', () => {
    const api = makeApi()
    const frame = {
      type: 'CALLBACK',
      headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'sys-1' },
      data: JSON.stringify({
        msgtype: 'text',
        text: { content: ' hello ' },
        senderStaffId: 's1',
        conversationId: 'c1',
        msgId: 'm1',
        sessionWebhook: 'https://x/sendBySession/abc',
      }),
    }
    expect(api.parseMessage(frame)).toEqual({
      staffId: 's1',
      conversationId: 'c1',
      msgId: 'm1',
      text: 'hello',
      sessionWebhook: 'https://x/sendBySession/abc',
    })
  })

  it('senderStaffId 缺失回退 senderId', () => {
    const api = makeApi()
    const frame = {
      type: 'CALLBACK',
      data: JSON.stringify({ msgtype: 'text', text: { content: 'hi' }, senderId: 's2' }),
    }
    expect(api.parseMessage(frame)!.staffId).toBe('s2')
  })

  it('非 text / 空文本 / 缺 sender → null', () => {
    const api = makeApi()
    const nonText = { type: 'CALLBACK', data: JSON.stringify({ msgtype: 'image' }) }
    const empty = {
      type: 'CALLBACK',
      data: JSON.stringify({ msgtype: 'text', text: { content: '' }, senderStaffId: 's' }),
    }
    const noSender = {
      type: 'CALLBACK',
      data: JSON.stringify({ msgtype: 'text', text: { content: 'hi' } }),
    }
    expect(api.parseMessage(nonText)).toBeNull()
    expect(api.parseMessage(empty)).toBeNull()
    expect(api.parseMessage(noSender)).toBeNull()
  })

  it('非 CALLBACK / data 非字符串 / 坏 JSON / null → null', () => {
    const api = makeApi()
    expect(api.parseMessage({ type: 'SYSTEM', data: '{}' })).toBeNull()
    expect(api.parseMessage({ type: 'CALLBACK', data: { not: 'a string' } })).toBeNull()
    expect(api.parseMessage({ type: 'CALLBACK', data: '{bad json' })).toBeNull()
    expect(api.parseMessage(null)).toBeNull()
    expect(api.parseMessage(undefined)).toBeNull()
  })
})

describe('createDingtalkApi.isPing/ack/pong', () => {
  it('isPing 识别 SYSTEM + topic ping', () => {
    const api = makeApi()
    expect(api.isPing({ type: 'SYSTEM', headers: { topic: 'ping' } })).toBe(true)
    expect(api.isPing({ type: 'SYSTEM', headers: { topic: 'other' } })).toBe(false)
    expect(api.isPing({ type: 'CALLBACK' })).toBe(false)
  })

  it('ack 发送 code 200 + headers.messageId', () => {
    const api = makeApi()
    const ws = new MockWS('x')
    api.ack(ws as any, { headers: { messageId: 'cb-1' } })
    const sent = JSON.parse(ws.sent[0]!)
    expect(sent.code).toBe(200)
    expect(sent.headers.messageId).toBe('cb-1')
    expect(sent.data).toBe('{"response": null}')
  })

  it('pong 回传 data + headers.messageId', () => {
    const api = makeApi()
    const ws = new MockWS('x')
    api.pong(ws as any, { headers: { messageId: 'sys-1' }, data: { x: 1 } })
    const sent = JSON.parse(ws.sent[0]!)
    expect(sent.code).toBe(200)
    expect(sent.headers.messageId).toBe('sys-1')
    expect(sent.data).toEqual({ x: 1 })
  })
})
