import { describe, it, expect, vi } from 'vitest'
import { createWecomAdapter } from '../../../src/daemon/wecom/adapter.js'

vi.spyOn(console, 'error').mockImplementation(() => {})

const config = { botId: 'b', botSecret: 's', allowedUserIds: ['alice'] }

function makeDeps() {
  const processPrompt = vi.fn(async () => {})
  return {
    processPrompt,
    sm: {
      getOrCreateByExternalUser: vi.fn(() => ({ id: 'sess-1', name: 'wecom-alice' })),
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
    open: vi.fn(() => ({
      set onopen(_: any) {},
      set onmessage(_: any) {},
      set onclose(_: any) {},
      send() {},
      close() {},
    })),
    subscribe: vi.fn(),
    ping: vi.fn(),
    attach: vi.fn(),
    respond: vi.fn(async () => {}),
    parseMessage: vi.fn(() => null),
    isDisconnected: vi.fn(() => false),
  } as any
}

describe('createWecomAdapter', () => {
  it('白名单 miss → 不跑 prompt 不回发', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createWecomAdapter({ ...config, allowedUserIds: [] }, api, deps)
    await a.handleMessage({ userId: 'alice', chatId: 'c1', msgId: 'm1', text: 'hi' })
    expect(deps.processPrompt).not.toHaveBeenCalled()
    expect(api.respond).not.toHaveBeenCalled()
  })

  it('白名单 hit → processPrompt 一次 + respond 回发', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createWecomAdapter(config, api, deps)
    await a.handleMessage({ userId: 'alice', chatId: 'c1', msgId: 'm1', text: 'hi' })
    expect(deps.processPrompt).toHaveBeenCalledWith('hi')
    expect(api.respond).toHaveBeenCalledWith('alice', '完成！')
  })

  it('会话映射用 wecom channel + userId', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createWecomAdapter(config, api, deps)
    await a.handleMessage({ userId: 'alice', chatId: 'c1', msgId: 'm1', text: 'hi' })
    expect(deps.sm.getOrCreateByExternalUser).toHaveBeenCalledWith(
      'wecom',
      'alice',
      '/tmp',
      'anthropic',
      'claude',
    )
  })

  it('start 幂等：重复调用返回同一 stop', () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createWecomAdapter(config, api, deps)
    const s1 = a.start()
    const s2 = a.start()
    expect(s1).toBe(s2)
    s1()
  })
})
