import { describe, it, expect, vi } from 'vitest'
vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 1 },
  Domain: { Feishu: 'feishu' },
  Client: class {
    im = { message: { create: vi.fn() } }
  },
  EventDispatcher: class {
    register(map: Record<string, (data: any) => unknown>) {
      this._map = map
      return this
    }
    _map: Record<string, (data: any) => unknown> = {}
    async invoke(_a: unknown) {
      return { code: 0 }
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

function makeDeps() {
  return {
    sm: {
      getOrCreateByFeishuOpenId: vi.fn(() => ({
        id: 'sess-1',
        name: 'feishu-ou_1',
        cwd: '/tmp',
        provider: 'anthropic',
        model: 'claude',
      })),
    } as any,
    getOrCreateWorker: vi.fn(() => ({
      processPrompt: vi.fn(async () => {}),
      getLastAssistantContent: () => '完成！',
    })) as any,
    rateLimiter: { check: vi.fn(() => ({ allowed: true })) } as any,
    cwd: '/tmp',
    provider: 'anthropic',
    model: 'claude',
  }
}

describe('createFeishuAdapter', () => {
  it('handleEvent 回显 challenge', async () => {
    const a = createFeishuAdapter(config, makeDeps())
    const res = await a.handleEvent(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ challenge: 'abc' }) }),
    )
    expect(await res.json()).toEqual({ challenge: 'abc' })
  })

  it('白名单外 openId 不跑 prompt', async () => {
    const deps = makeDeps()
    // 通过 dispatcher 触发 onMessage —— 直接调用内部 onMessage 不可行，改测 handleEvent 路径：
    // 这里用未授权配置重建 adapter，验证白名单过滤在 adapter 层生效。
    const a = createFeishuAdapter({ ...config, allowedOpenIds: [] }, deps)
    // 加密事件走 invoke，无法在单测里模拟解密；白名单过滤逻辑抽成纯函数 isAllowed 便于测试
    expect(a.isAllowed('ou_x')).toBe(false)
  })
})
