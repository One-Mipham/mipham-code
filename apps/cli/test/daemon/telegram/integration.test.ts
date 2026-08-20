import { describe, it, expect, vi } from 'vitest'
import { createTelegramAdapter } from '../../../src/daemon/telegram/adapter.js'

vi.spyOn(console, 'error').mockImplementation(() => {})

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

describe('telegram 集成（poller → adapter → 回发）', () => {
  it('一条 text update 端到端触发 prompt + 回发', async () => {
    const deps = makeDeps()
    const sendText = vi.fn(async () => {})
    // getUpdates 首次返回一条，之后挂起（模拟长轮询阻塞）
    let calls = 0
    const api = {
      getUpdates: vi.fn(() => {
        calls++
        if (calls === 1) {
          return Promise.resolve([
            { update_id: 1, message: { chat: { id: 111 }, message_id: 5, text: 'hi' } },
          ])
        }
        return new Promise(() => {}) // 挂起
      }),
      sendText,
    } as any

    const adapter = createTelegramAdapter({ botToken: 'x', allowedChatIds: ['111'] }, api, deps)
    const stop = adapter.start()

    // 等首个 loop 完成（getUpdates 已 resolve + handleMessage 已 await）
    await vi.waitFor(() => expect(deps.processPrompt).toHaveBeenCalledWith('hi'))
    expect(sendText).toHaveBeenCalledWith('111', 'done')
    stop()
  })
})
