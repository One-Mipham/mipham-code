import { describe, it, expect, vi } from 'vitest'

/**
 * 远程 attach 模式下，会话状态都在 daemon 上：
 * - `RemoteEngine.getContext()` 只给 4 个方法与空实现（`remote-engine.ts:326-342`），
 *   而 `/compact` / `/context` 读 `getMessageCount` / `compact` / `getSystemPrompt` 等
 *   ⇒ 点开就 TypeError；
 * - `/clear` / `/goal` / `/effort` 调的是 no-op（`setGoal` / `setEffort`），
 *   却照旧回「✓ 已确认」——**一次没发生的操作与一次成功的操作长得一模一样**。
 *
 * 判据：远程模式必须明说，且**不**产生任何本地状态迁移；本地模式行为不变。
 */

vi.mock('../../src/core/session-store', () => ({
  SessionStore: {
    getLatest: vi.fn(() => null),
    load: vi.fn(() => null),
    list: vi.fn(() => []),
    delete: vi.fn(() => false),
  },
}))

const { getCommand } = await import('../../src/ui/commands')

type Cmd = (ctx: unknown, args: string[]) => unknown

function mkRemoteCtx(overrides: Record<string, unknown> = {}) {
  const getContext = vi.fn(() => {
    throw new Error('a remote session must not read a local context')
  })
  return {
    engine: {
      isRemote: true,
      getContext,
      setGoal: vi.fn(),
      setEffort: vi.fn(),
    },
    config: { providers: [] },
    providerId: 'deepseek',
    modelId: 'deepseek-v4-pro',
    version: '0.0.0',
    sessionId: 'remote-command-test',
    setSessionTitle: vi.fn(),
    setEffort: vi.fn(),
    setFocusMode: vi.fn(),
    setGoal: vi.fn(),
    setUltracodeMode: vi.fn(),
    setUpdateStatus: vi.fn(),
    ...overrides,
  }
}

function mkLocalCtx() {
  return mkRemoteCtx({
    engine: {
      isRemote: false,
      getContext: () => ({
        getMessages: () => [],
        getEstimatedTokens: () => 0,
        getMessageCount: () => 0,
        getCheckpoints: () => [],
        clear: vi.fn(),
      }),
      setGoal: vi.fn(),
    },
  })
}

describe('远程 attach：context 类命令不再崩溃或假成功', () => {
  for (const name of ['/compact', '/context']) {
    it(`${name} 明说会话在 daemon 上，且不读本地 context`, async () => {
      const ctx = mkRemoteCtx()
      const res = (await (getCommand(name)! as Cmd)(ctx, [])) as { content: string }

      expect(res.content).toContain('attached to a daemon')
      expect(ctx.engine.getContext).not.toHaveBeenCalled()
      expect(res.content).not.toContain('✓')
    })
  }
})

describe('远程 attach：状态类命令不再假成功', () => {
  it('/clear 明确拒绝，且不清本地视图', async () => {
    const ctx = mkRemoteCtx()
    const res = (await (getCommand('/clear')! as Cmd)(ctx, [])) as {
      content: string
      clearMessages?: boolean
    }

    expect(res.content).toContain('attached to a daemon')
    expect(res.clearMessages).toBeUndefined()
  })

  it('/goal 不调用本地 setGoal，也不声称已设置', async () => {
    const ctx = mkRemoteCtx()
    const res = (await (getCommand('/goal')! as Cmd)(ctx, ['Ship', 'it'])) as { content: string }

    expect(res.content).toContain('attached to a daemon')
    expect(ctx.setGoal).not.toHaveBeenCalled()
    expect(ctx.engine.setGoal).not.toHaveBeenCalled()
    expect(res.content).not.toContain('✓ Goal set')
  })

  it('/effort 不调用本地 setEffort，也不声称已确认', async () => {
    const ctx = mkRemoteCtx()
    const res = (await (getCommand('/effort')! as Cmd)(ctx, ['high'])) as { content: string }

    expect(res.content).toContain('attached to a daemon')
    expect(ctx.setEffort).not.toHaveBeenCalled()
    expect(res.content).not.toContain('✓')
  })
})

describe('本地模式：同样这几条命令照旧生效（防止守卫过宽）', () => {
  it('/clear 仍然清空并请求清屏', async () => {
    const ctx = mkLocalCtx()
    const res = (await (getCommand('/clear')! as Cmd)(ctx, [])) as {
      content: string
      clearMessages?: boolean
    }

    expect(res.clearMessages).toBe(true)
  })

  it('/goal 仍然落地并回确认', async () => {
    const ctx = mkLocalCtx()
    const res = (await (getCommand('/goal')! as Cmd)(ctx, ['Ship', 'it'])) as { content: string }

    expect(ctx.setGoal).toHaveBeenCalledWith('Ship it')
    expect(ctx.engine.setGoal).toHaveBeenCalled()
    expect(res.content).toContain('✓ Goal set')
  })

  it('/effort 仍然落地并回确认', async () => {
    const ctx = mkLocalCtx()
    const res = (await (getCommand('/effort')! as Cmd)(ctx, ['high'])) as { content: string }

    expect(ctx.setEffort).toHaveBeenCalledWith('high')
    expect(res.content).toContain('✓')
  })
})
