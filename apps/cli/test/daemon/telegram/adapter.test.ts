import { describe, it, expect, vi } from 'vitest'
import { createTelegramAdapter } from '../../../src/daemon/telegram/adapter.js'

vi.spyOn(console, 'error').mockImplementation(() => {})

const config = { botToken: '123:abc', allowedChatIds: ['111'] }

function makeDeps() {
  const processPrompt = vi.fn(async () => {})
  return {
    processPrompt,
    sm: {
      getOrCreateByExternalUser: vi.fn(() => ({ id: 'sess-1', name: 'telegram-111' })),
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
    getUpdates: vi.fn(() => new Promise(() => {})), // 默认挂起，供 start() 测试
    sendText: vi.fn(async () => {}),
  } as any
}

describe('createTelegramAdapter', () => {
  it('白名单 miss → 不跑 prompt 不回发', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createTelegramAdapter({ ...config, allowedChatIds: [] }, api, deps)
    await a.handleMessage({ chatId: '111', messageId: 1, text: 'hi' })
    expect(deps.processPrompt).not.toHaveBeenCalled()
    expect(api.sendText).not.toHaveBeenCalled()
  })

  it('白名单 hit → processPrompt 一次 + 回发最终内容', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createTelegramAdapter(config, api, deps)
    await a.handleMessage({ chatId: '111', messageId: 1, text: 'hi' })
    expect(deps.processPrompt).toHaveBeenCalledWith('hi')
    expect(api.sendText).toHaveBeenCalledWith('111', '完成！')
  })

  it('会话映射用 telegram channel', async () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createTelegramAdapter(config, api, deps)
    await a.handleMessage({ chatId: '111', messageId: 1, text: 'hi' })
    expect(deps.sm.getOrCreateByExternalUser).toHaveBeenCalledWith(
      'telegram',
      '111',
      '/tmp',
      'anthropic',
      'claude',
    )
  })

  it('worker null → 回发「初始化失败」', async () => {
    const deps = makeDeps()
    ;(deps.getOrCreateWorker as any).mockReturnValue(null)
    const api = makeApi()
    const a = createTelegramAdapter(config, api, deps)
    await a.handleMessage({ chatId: '111', messageId: 1, text: 'hi' })
    expect(api.sendText).toHaveBeenCalledWith('111', '（会话初始化失败，请稍后重试）')
  })

  it('回发失败 → 不 rethrow，prompt 只跑一次', async () => {
    const deps = makeDeps()
    const api = makeApi()
    api.sendText.mockRejectedValue(new Error('send failed'))
    const a = createTelegramAdapter(config, api, deps)
    await expect(
      a.handleMessage({ chatId: '111', messageId: 1, text: 'hi' }),
    ).resolves.toBeUndefined()
    expect(deps.processPrompt).toHaveBeenCalledTimes(1)
  })

  it('start 幂等：重复调用返回同一 stop', () => {
    const deps = makeDeps()
    const api = makeApi()
    const a = createTelegramAdapter(config, api, deps)
    const s1 = a.start()
    const s2 = a.start()
    expect(s1).toBe(s2)
    s1()
  })
})
