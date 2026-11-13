import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * `/cd` 以前只搬 `process.cwd()`：**按目录装载的闸门**全都留在原目录，
 * 而输出只说「已切换」。于是用户以为新项目的策略已经生效。
 *
 * 现在分两半说清楚：能重放的（settings.json 的权限规则、`.mipham/rules`）
 * 当场重放；启动时一次性装载的（config.yml permissionRules、hooks、指令文件）
 * 明确说出来仍然属于原目录，要重启才换。
 */

const h = vi.hoisted(() => ({
  loadSettingsJson: vi.fn(),
}))

vi.mock('../../src/config/loader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/loader')>()),
  loadSettingsJson: h.loadSettingsJson,
}))

vi.mock('../../src/core/rules-loader', () => ({
  RulesLoader: class {
    constructor(public cwd: string) {}
  },
}))

vi.mock('../../src/core/session-store', () => ({
  SessionStore: { load: vi.fn(() => null), save: vi.fn(), saveLog: vi.fn() },
}))

const { getCommand } = await import('../../src/ui/commands')
const cdCmd = getCommand('/cd')!

function mkCtx(options: { remote?: boolean } = {}) {
  // 真 `PermissionSystem` 的 `allow`/`deny` 是**追加**语义，`listRules()` 按 pattern
  // 去重 —— 替身要照这个形状立，否则「重放」这条分支根本走不到。
  const live = new Map<string, string>()
  // attach 模式的 `getPermission()` 只有这两个方法，这里照实立：
  // 任何在它上面调 `listRules`/`allow` 的代码都会当场抛。
  const facade = {
    setMode: vi.fn(),
    getMode: () => 'default' as const,
  }
  const permission = {
    allow: vi.fn((r: string) => void live.set(r, 'bypass')),
    deny: vi.fn((r: string) => void live.set(r, 'ask')),
    listRules: () => live,
  }
  const setRulesLoader = vi.fn()
  const ctx = {
    sessionId: 'cd-test',
    engine: {
      isRemote: options.remote === true,
      getPermission: () => (options.remote ? facade : permission),
      setRulesLoader,
      getContext: () => ({ getLog: () => null }),
    },
  }
  return { ctx: ctx as unknown as Parameters<typeof cdCmd>[0], permission, setRulesLoader }
}

let dir: string
let originalCwd: string

beforeEach(() => {
  originalCwd = process.cwd()
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-cd-')))
  h.loadSettingsJson.mockReset()
  h.loadSettingsJson.mockReturnValue({ permissions: { allow: [], deny: [] }, hooks: {} })
})

afterEach(() => {
  process.chdir(originalCwd)
  rmSync(dir, { recursive: true, force: true })
})

describe('/cd 重放新目录的策略，并说清搬不动的那一半', () => {
  it('settings.json 的 allow/deny 当场重放，规则加载器换到新目录', async () => {
    h.loadSettingsJson.mockReturnValue({
      permissions: { allow: ['Bash(npm test)'], deny: ['Read(**/.env)'] },
      hooks: {},
    })
    const { ctx, permission, setRulesLoader } = mkCtx()

    const res = await cdCmd(ctx, [dir])

    expect(process.cwd()).toBe(resolve(dir))
    expect(permission.allow).toHaveBeenCalledWith('Bash(npm test)')
    expect(permission.deny).toHaveBeenCalledWith('Read(**/.env)')
    expect(setRulesLoader).toHaveBeenCalledTimes(1)
    expect((setRulesLoader.mock.calls[0]![0] as { cwd: string }).cwd).toBe(resolve(dir))
    expect(res.content).toContain('Applied 2 settings.json permission rule(s)')
    expect(res.content).toContain('Project rules now read from this directory.')
  })

  it('永远说清「启动时装载、仍属于原目录」的那三样', async () => {
    const { ctx } = mkCtx()
    const res = await cdCmd(ctx, [dir])

    expect(res.content).toContain('still belonging to the original directory until restart')
    expect(res.content).toContain('config.yml permissionRules')
    expect(res.content).toContain('hooks')
    expect(res.content).toContain('instruction files')
  })

  it('没有任何规则可重放 ⇒ 不许声称「已应用」', async () => {
    const { ctx, permission } = mkCtx()
    const res = await cdCmd(ctx, [dir])

    expect(permission.allow).not.toHaveBeenCalled()
    expect(permission.deny).not.toHaveBeenCalled()
    expect(res.content).not.toContain('Applied')
  })

  it('连续 `/cd` 不重复施加同一批规则（也不会把重放报成新施加）', async () => {
    h.loadSettingsJson.mockReturnValue({
      permissions: { allow: ['Bash(npm test)'], deny: ['Read(**/.env)'] },
      hooks: {},
    })
    const { ctx, permission } = mkCtx()

    await cdCmd(ctx, [dir])
    const second = await cdCmd(ctx, [dir])

    expect(permission.allow).toHaveBeenCalledTimes(1)
    expect(permission.deny).toHaveBeenCalledTimes(1)
    expect(second.content).not.toContain('Applied')
  })

  it('attach 模式：说清策略属于 daemon，不假装重放过', async () => {
    h.loadSettingsJson.mockReturnValue({
      permissions: { allow: ['Bash(npm test)'], deny: [] },
      hooks: {},
    })
    const { ctx, permission, setRulesLoader } = mkCtx({ remote: true })

    const res = await cdCmd(ctx, [dir])

    expect(permission.allow).not.toHaveBeenCalled()
    expect(setRulesLoader).not.toHaveBeenCalled()
    expect(res.content).toContain('attached to a daemon')
    expect(res.content).toContain('belong to the daemon')
    // 不许把内部实现细节当错误印出来
    expect(res.content).not.toContain('is not a function')
    expect(res.content).not.toContain('Could not reload')
  })

  it('目标不存在 ⇒ 不切目录、不动策略', async () => {
    const { ctx, setRulesLoader } = mkCtx()
    const before = process.cwd()

    const res = await cdCmd(ctx, [join(dir, 'nope-does-not-exist')])

    expect(process.cwd()).toBe(before)
    expect(setRulesLoader).not.toHaveBeenCalled()
    expect(res.content).not.toContain('Project rules')
  })
})
