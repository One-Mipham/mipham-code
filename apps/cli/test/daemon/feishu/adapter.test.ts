import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.spyOn(console, 'error').mockImplementation(() => {})

const messageCreateMock = vi.fn()
const sdkInvokeMock = vi.fn()

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 1 },
  Domain: { Feishu: 'feishu' },
  Client: class {
    im = { message: { create: messageCreateMock } }
  },
  EventDispatcher: class {
    register(map: Record<string, (data: any) => unknown>) {
      this._map = map
      return this
    }
    _map: Record<string, (data: any) => unknown> = {}
    async invoke(assigned: unknown) {
      return sdkInvokeMock(assigned, this._map)
    }
  },
}))

import { createFeishuAdapter } from '../../../src/daemon/feishu/adapter.js'

const config = {
  appId: 'a',
  appSecret: 's',
  encryptKey: 'k',
  verificationToken: 't',
  allowedOpenIds: ['ou_1'],
}

const textEventBody = {
  message: {
    chat_id: 'c1',
    message_id: 'm1',
    message_type: 'text',
    content: JSON.stringify({ text: 'hi' }),
  },
  sender: { sender_id: { open_id: 'ou_1' } },
}

function makeDeps() {
  const processPrompt = vi.fn(async () => {})
  return {
    processPrompt,
    sm: {
      getOrCreateByExternalUser: vi.fn(() => ({
        id: 'sess-1',
        name: 'feishu-ou_1',
        cwd: '/tmp',
        provider: 'anthropic',
        model: 'claude',
      })),
    } as any,
    getOrCreateWorker: vi.fn(() => ({
      processPrompt,
      getLastAssistantContent: () => '完成！',
    })) as any,
    rateLimiter: { check: vi.fn(() => ({ allowed: true })) } as any,
    cwd: '/tmp',
    provider: 'anthropic',
    model: 'claude',
  }
}

// 默认让 SDK EventDispatcher.invoke 模拟「验签通过 + 派发 handler」
function mockSdkDispatch() {
  sdkInvokeMock.mockImplementation(
    async (_assigned: unknown, map: Record<string, (data: any) => unknown>) => {
      const handler = map['im.message.receive_v1']
      if (!handler) return 'no im.message.receive_v1 event handle'
      return await handler(_assigned)
    },
  )
}

function requestWithBody(body: unknown): Request {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  messageCreateMock.mockReset()
  sdkInvokeMock.mockReset()
  mockSdkDispatch()
})

describe('createFeishuAdapter', () => {
  it('handleEvent 回显 challenge', async () => {
    const a = createFeishuAdapter(config, makeDeps())
    const res = await a.handleEvent(requestWithBody({ challenge: 'abc' }))
    expect(await res.json()).toEqual({ challenge: 'abc' })
  })

  it('白名单 miss → 不跑 prompt，返回 200', async () => {
    const deps = makeDeps()
    const a = createFeishuAdapter({ ...config, allowedOpenIds: [] }, deps)
    const res = await a.handleEvent(requestWithBody(textEventBody))
    expect(res.status).toBe(200)
    expect(deps.processPrompt).not.toHaveBeenCalled()
    expect(messageCreateMock).not.toHaveBeenCalled()
  })

  it('白名单 hit → processPrompt 调用一次 + 回送消息', async () => {
    const deps = makeDeps()
    const a = createFeishuAdapter(config, deps)
    const res = await a.handleEvent(requestWithBody(textEventBody))
    expect(res.status).toBe(200)
    expect(deps.processPrompt).toHaveBeenCalledTimes(1)
    expect(deps.processPrompt).toHaveBeenCalledWith('hi')
    expect(messageCreateMock).toHaveBeenCalledTimes(1)
  })

  it('验签失败（SDK invoke → undefined）→ 4xx', async () => {
    sdkInvokeMock.mockResolvedValue(undefined)
    const deps = makeDeps()
    const a = createFeishuAdapter(config, deps)
    const res = await a.handleEvent(requestWithBody(textEventBody))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 1, msg: 'invalid_signature' })
    expect(deps.processPrompt).not.toHaveBeenCalled()
  })

  it('无 handler（SDK invoke → "no X event handle"）→ 4xx', async () => {
    sdkInvokeMock.mockResolvedValue('no im.message.receive_v1 event handle')
    const deps = makeDeps()
    const a = createFeishuAdapter(config, deps)
    const res = await a.handleEvent(requestWithBody(textEventBody))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 1, msg: 'no_handler' })
    expect(deps.processPrompt).not.toHaveBeenCalled()
  })

  it('回送失败 → 200（不 rethrow），processPrompt 只跑一次', async () => {
    messageCreateMock.mockRejectedValue(new Error('send failed'))
    const deps = makeDeps()
    const a = createFeishuAdapter(config, deps)
    const res = await a.handleEvent(requestWithBody(textEventBody))
    expect(res.status).toBe(200)
    expect(deps.processPrompt).toHaveBeenCalledTimes(1)
  })
})
