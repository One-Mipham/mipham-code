import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 远程 attach 模式下，`RemoteEngine.switchProvider` 是 no-op（daemon 管 provider/model）。
 *
 * 从前 `/switch` 照样回「✓ Switched」并把 `nextProvider`/`nextModel` 交给调用方去改页脚 ——
 * 于是页脚显示新模型、daemon 还跑着旧模型。**一次没发生的切换与一次成功的切换长得一模一样。**
 * 现在：远程模式下明说切不了，且**不**产生 nextProvider/nextModel。
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
const switchCmd = getCommand('/switch')!

function mkCtx(engine: Record<string, unknown>) {
  return {
    engine,
    config: {
      providers: [
        { id: 'deepseek', name: 'DeepSeek', apiKey: 'sk-test', models: [], status: 'active' },
      ],
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-v4-pro',
    },
    providerId: 'deepseek',
    modelId: 'deepseek-v4-pro',
  } as unknown as Parameters<typeof switchCmd>[0]
}

describe('/switch 在远程 attach 模式下', () => {
  it('明说切不了，且不声称已切换', async () => {
    const switchProvider = vi.fn()
    const res = await switchCmd(mkCtx({ isRemote: true, switchProvider }), [
      'deepseek',
      'deepseek-v4-pro',
    ])

    expect(switchProvider).not.toHaveBeenCalled()
    expect(res.content).toContain('Cannot switch')
    expect(res.content).toContain('attached to a daemon')
    expect(res.content).not.toContain('✓ Switched')
  })

  it('不返回 nextProvider/nextModel —— 页脚不许跟着变', async () => {
    const res = await switchCmd(mkCtx({ isRemote: true, switchProvider: vi.fn() }), [
      'deepseek',
      'deepseek-v4-pro',
    ])
    expect(res.nextProvider).toBeUndefined()
    expect(res.nextModel).toBeUndefined()
  })

  it('本地配置里没这个 provider、或没配 key 时，仍然说 daemon —— 本地这份不是判据', async () => {
    const ctx = mkCtx({ isRemote: true, switchProvider: vi.fn() })
    // 本地根本不认识这个 provider
    ;(ctx as unknown as { config: { providers: unknown[] } }).config.providers = []

    const res = await switchCmd(ctx, ['nowhere', 'no-model'])

    expect(res.content).toContain('attached to a daemon')
    expect(res.content).not.toContain('Unknown provider')
    expect(res.content).not.toContain('API key')
  })

  it('本地引擎照旧切换并回确认', async () => {
    const switchProvider = vi.fn(() => undefined)
    const res = await switchCmd(mkCtx({ isRemote: false, switchProvider }), [
      'deepseek',
      'deepseek-v4-pro',
    ])

    expect(switchProvider).toHaveBeenCalledWith('deepseek', 'deepseek-v4-pro')
    expect(res.content).toContain('✓ Switched')
    expect(res.nextProvider).toBe('deepseek')
    expect(res.nextModel).toBe('deepseek-v4-pro')
  })
})

/**
 * 第二个入口：`ModelPicker`（Ctrl+P 选模型）走的是 app.tsx 里的 `onSelect` 闭包，
 * 不经过 `/switch`。上面的行为用例够不到它 —— 它是 JSX 属性里的内联函数，渲染整个
 * `App` 才碰得到。故与 `test/integrity/permission-status-parity.test.ts` 同法，
 * **从源码侧断接线**：判据是「负锚在场即红」，不是「读起来像对的」。
 */
describe('ModelPicker 的 onSelect 也必须先看 isRemote', () => {
  const APP = readFileSync(join(import.meta.dirname, '..', '..', 'src/ui/app.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')

  /** `<ModelPicker … onSelect={…}` 到 `onNeedsApiKey` 之间的那段。 */
  function pickerOnSelect(): string {
    const start = APP.indexOf('onSelect={(newProvider, newModel) => {')
    expect(
      start,
      'ModelPicker 的 onSelect 找不到 —— 源码形状变了，这条守卫要跟着改',
    ).toBeGreaterThan(-1)
    const end = APP.indexOf('onNeedsApiKey', start)
    expect(end).toBeGreaterThan(start)
    return APP.slice(start, end)
  }

  it('守卫在 switchProvider 之前，且该段只有一处 switchProvider 调用', () => {
    const block = pickerOnSelect()
    const guard = block.indexOf('engine.isRemote')
    const call = block.indexOf('engine.switchProvider(')

    expect(guard, 'picker 的 onSelect 里没有 isRemote 守卫').toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(call)
    // 守卫之后又冒出一处切换调用 ⇒ 那一处绕过了守卫。
    expect(block.indexOf('engine.switchProvider(', call + 1)).toBe(-1)
  })
})
