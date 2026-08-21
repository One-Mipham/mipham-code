import { describe, it, expect, vi } from 'vitest'
import { handleChannelMessage } from '../../src/daemon/channel-message.js'

vi.spyOn(console, 'error').mockImplementation(() => {})

function makeOpts(overrides: Partial<any> = {}) {
  const processPrompt = vi.fn(async () => {})
  const worker = {
    processPrompt,
    getLastAssistantContent: () => '完成！',
  }
  return {
    channel: 'feishu',
    externalId: 'ou_1',
    text: 'hi',
    allowed: new Set(['ou_1']),
    rateLimiter: { check: vi.fn(() => ({ allowed: true })) } as any,
    sm: {
      getOrCreateByExternalUser: vi.fn(() => ({ id: 'sess-1' })),
    } as any,
    getOrCreateWorker: vi.fn(() => worker) as any,
    cwd: '/tmp',
    provider: 'anthropic',
    model: 'claude',
    sendText: vi.fn(async () => {}),
    maxLen: 4000,
    logPrefix: '[feishu]',
    ...overrides,
  }
}

describe('handleChannelMessage', () => {
  it('白名单 miss → 不跑 prompt 不回发', async () => {
    const o = makeOpts({ allowed: new Set([]) })
    await handleChannelMessage(o)
    expect(o.sm.getOrCreateByExternalUser).not.toHaveBeenCalled()
    expect(o.sendText).not.toHaveBeenCalled()
  })

  it('白名单 hit → processPrompt 一次 + 回发最终内容', async () => {
    const o = makeOpts()
    await handleChannelMessage(o)
    expect(o.sm.getOrCreateByExternalUser).toHaveBeenCalledWith(
      'feishu',
      'ou_1',
      '/tmp',
      'anthropic',
      'claude',
    )
    expect(o.sendText).toHaveBeenCalledWith('ou_1', '完成！')
  })

  it('worker null → 回发「初始化失败」', async () => {
    const o = makeOpts({ getOrCreateWorker: () => null })
    await handleChannelMessage(o)
    expect(o.sendText).toHaveBeenCalledWith('ou_1', '（会话初始化失败，请稍后重试）')
  })

  it('回发失败 → 不 rethrow，prompt 只跑一次', async () => {
    const o = makeOpts()
    o.sendText.mockRejectedValue(new Error('send failed'))
    await expect(handleChannelMessage(o)).resolves.toBeUndefined()
    expect(o.getOrCreateWorker).toHaveBeenCalledTimes(1)
  })

  it('截断超长回复到 maxLen', async () => {
    const o = makeOpts({ maxLen: 5 })
    ;(o.getOrCreateWorker() as any).getLastAssistantContent = () => 'abcdefghij'
    await handleChannelMessage(o)
    expect(o.sendText).toHaveBeenCalledWith('ou_1', 'abcde')
  })
})
