import { describe, it, expect, vi } from 'vitest'
import { createDingtalkAdapter } from '../../../src/daemon/dingtalk/adapter.js'

vi.spyOn(console, 'error').mockImplementation(() => {})

const config = { clientId: 'id', clientSecret: 'secret', allowedStaffIds: ['alice'] }

function makeDeps() {
  const processPrompt = vi.fn(async () => {})
  return {
    processPrompt,
    sm: {
      getOrCreateByExternalUser: vi.fn(() => ({ id: 'sess-1', name: 'dingtalk-alice' })),
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

function makeApi() {
  return {
    register: vi.fn(async () => ({ endpoint: 'wss://x', ticket: 't' })),
    open: vi.fn(() => ({
      set onopen(_: any) {},
      set onmessage(_: any) {},
      set onclose(_: any) {},
      send() {},
      close() {},
    })),
    reply: vi.fn(async () => {}),
    parseMessage: vi.fn(() => null),
    isPing: vi.fn(() => false),
    ack: vi.fn(),
    pong: vi.fn(),
  } as any
}

function makeMsg(): Parameters<ReturnType<typeof createDingtalkAdapter>['handleMessage']>[0] {
  return {
    staffId: 'alice',
    conversationId: 'c1',
    msgId: 'm1',
    text: 'hi',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession/abc',
  }
}

describe('createDingtalkAdapter', () => {
  it('白名单 miss → 不跑 prompt 不回发', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createDingtalkAdapter({ ...config, allowedStaffIds: [] }, api, deps)
    await a.handleMessage(makeMsg())
    expect(deps.processPrompt).not.toHaveBeenCalled()
    expect(api.reply).not.toHaveBeenCalled()
  })

  it('白名单 hit → processPrompt 一次 + reply 走 sessionWebhook', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createDingtalkAdapter(config, api, deps)
    await a.handleMessage(makeMsg())
    expect(deps.processPrompt).toHaveBeenCalledWith('hi')
    expect(api.reply).toHaveBeenCalledWith(
      'https://oapi.dingtalk.com/robot/sendBySession/abc',
      '完成！',
    )
  })

  it('会话映射用 dingtalk channel + staffId', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createDingtalkAdapter(config, api, deps)
    await a.handleMessage(makeMsg())
    expect(deps.sm.getOrCreateByExternalUser).toHaveBeenCalledWith(
      'dingtalk',
      'alice',
      '/tmp',
      'anthropic',
      'claude',
    )
  })

  it('isAllowed 判 staffId', () => {
    const deps = makeDeps()
    const a = createDingtalkAdapter(config, makeApi(), deps)
    expect(a.isAllowed('alice')).toBe(true)
    expect(a.isAllowed('bob')).toBe(false)
  })

  it('start 幂等：重复调用返回同一 stop', () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createDingtalkAdapter(config, api, deps)
    const s1 = a.start()
    const s2 = a.start()
    expect(s1).toBe(s2)
    s1()
  })
})
