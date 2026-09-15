/**
 * /init 与 /setup 1 生成的 config.yml —— 预置 provider 清单
 *
 * 回归锚点：这两个生成器挑选「要预置哪些 provider」时用的是一句
 * `ctx.config.providers.filter(p => p.status === 'active')`。
 * 但 12 个 provider 里**只有 `mipham` 声明了顶层 `status`** —— 其余 11 家的
 * `status` 全在 model 层（`DEFAULT_PROVIDERS` 里 provider 对象根本没有这个字段）。
 * 于是过滤结果恒为 1：新用户跑完 /init 拿到的 config.yml 只有 MiphamAI，
 * 而 /setup 1 的模板注释还硬写着「8 configured」。
 *
 * 这个过滤器在别处是对的（`ctx.config.providers` 是**运行时**配置，那里的 status
 * 可以表示「用户停用了某家」），错的是拿它当**代码生成**的来源 —— 生成物应该来自
 * 我们随包发布的清单 CLOUD_PROVIDERS，与任何运行时状态无关。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// 隔离真实 ~/.mipham —— /init 会写用户级 config.yml。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-init-providers` }
})

import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { initCmd, setupCmd } from '../../src/commands/project'
import { CLOUD_PROVIDERS } from '../../src/config/wizard-config'
import { DEFAULT_PROVIDERS } from '../../src/shared/constants'
import type { CommandContext } from '../../src/ui/commands'

const MIPHAM_HOME = join(homedir(), '.mipham')
const PROJECT_CWD = join(tmpdir(), 'mipham-test-init-providers-cwd')

/**
 * 让被测代码看到的 cwd 指向临时项目目录（`setupCmd` 读 `process.cwd()`）。
 *
 * 不用 `process.chdir()`：那是进程级全局突变，而 Stryker 的 vitest-runner 把测试跑在
 * worker 线程里（`pool: 'threads'` 在它源码里写死、无覆盖入口），线程里 chdir 直接抛
 * "process.chdir() is not supported in workers" —— 后果不是这一个文件红，而是整个
 * 变异测试的干跑失败。spy 只改 `process.cwd()` 的返回值，两种跑池下行为一致，也不再
 * 需要 afterEach 把整个进程的 cwd 搬回去（本仓库两次测试隔离事故的共同点正是这种
 * 进程级可变状态）。
 */
function useProjectCwd(): void {
  vi.spyOn(process, 'cwd').mockReturnValue(PROJECT_CWD)
}

function fakeCtx(): CommandContext {
  return {
    config: { providers: DEFAULT_PROVIDERS, permission: 'ask' },
    providerId: 'deepseek',
    modelId: 'deepseek-v4-pro',
  } as unknown as CommandContext
}

/** 抽出生成文件里 `providers:` 段下的 `- id: <x>` 清单。 */
function providerIdsIn(yaml: string): string[] {
  return [...yaml.matchAll(/^ {2}- id: (\S+)$/gm)].map((m) => m[1]!)
}

/** 抽出生成文件里 `apiKey: "${VAR}"` 的变量名清单。 */
function envVarsIn(yaml: string): string[] {
  return [...yaml.matchAll(/apiKey: "\$\{([^}]+)\}"/g)].map((m) => m[1]!)
}

beforeEach(() => {
  rmSync(MIPHAM_HOME, { recursive: true, force: true })
  rmSync(PROJECT_CWD, { recursive: true, force: true })
  mkdirSync(MIPHAM_HOME, { recursive: true })
  mkdirSync(PROJECT_CWD, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(MIPHAM_HOME, { recursive: true, force: true })
  rmSync(PROJECT_CWD, { recursive: true, force: true })
})

describe('/init 预置的 provider 清单', () => {
  it('保险丝：云端清单本身不为空且多于一家', () => {
    // 若 CLOUD_PROVIDERS 被改成空/一家，下面的断言会静默失去意义。
    expect(CLOUD_PROVIDERS.length).toBeGreaterThan(1)
  })

  it('预置全部云端 provider，而不是只预置声明了 status 的那一家', async () => {
    await initCmd(fakeCtx(), [])
    const yaml = readFileSync(join(MIPHAM_HOME, 'config.yml'), 'utf-8')
    const ids = providerIdsIn(yaml)

    expect(ids).toEqual(CLOUD_PROVIDERS.map((p) => p.id))
    expect(ids.length).toBeGreaterThan(1)
  })

  it('成功回执里报的 provider 数与文件内容一致', async () => {
    const result = await initCmd(fakeCtx(), [])
    const yaml = readFileSync(join(MIPHAM_HOME, 'config.yml'), 'utf-8')
    const n = providerIdsIn(yaml).length

    expect(result.content).toContain(`${n} providers pre-configured`)
  })
})

describe('/setup 1 预置的 provider 清单', () => {
  it('与 /init 使用同一份清单', async () => {
    useProjectCwd()
    await setupCmd(fakeCtx(), ['1'])
    const yaml = readFileSync(join(PROJECT_CWD, '.mipham', 'config.yml'), 'utf-8')

    expect(providerIdsIn(yaml)).toEqual(CLOUD_PROVIDERS.map((p) => p.id))
  })

  it('模板注释里的家数是算出来的，不是硬编码的 8', async () => {
    useProjectCwd()
    await setupCmd(fakeCtx(), ['1'])
    const yaml = readFileSync(join(PROJECT_CWD, '.mipham', 'config.yml'), 'utf-8')
    const n = providerIdsIn(yaml).length

    expect(yaml).not.toMatch(/\(\d+ configured/)
    expect(yaml).toContain(`${n} pre-configured`)
  })
})

describe('预置清单与运行时 status 解耦', () => {
  it('把所有 provider 的 status 抹掉，清单不变', async () => {
    const stripped = DEFAULT_PROVIDERS.map(({ status: _status, ...rest }) => rest)
    const ctx = {
      config: { providers: stripped, permission: 'ask' },
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
    } as unknown as CommandContext

    await initCmd(ctx, [])
    const yaml = readFileSync(join(MIPHAM_HOME, 'config.yml'), 'utf-8')

    expect(providerIdsIn(yaml)).toEqual(CLOUD_PROVIDERS.map((p) => p.id))
  })

  it('把某家标成 upcoming，也不会把它从生成物里剔除', async () => {
    const demoted = DEFAULT_PROVIDERS.map((p) =>
      p.id === 'anthropic' ? { ...p, status: 'upcoming' as const } : p,
    )
    const ctx = {
      config: { providers: demoted, permission: 'ask' },
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
    } as unknown as CommandContext

    await initCmd(ctx, [])
    const yaml = readFileSync(join(MIPHAM_HOME, 'config.yml'), 'utf-8')

    expect(providerIdsIn(yaml)).toContain('anthropic')
  })
})

describe('生成的 API key 占位符是合法的 shell 环境变量名', () => {
  // 模板头部写着 `export <名字>=...`，而 shell 只接受 [A-Za-z_][A-Za-z0-9_]*。
  // `minimax-global` 这类带连字符的 id 若直接 toUpperCase()，会生成
  // `export MINIMAX-GLOBAL_API_KEY=…` —— 一条 shell 语法错误，占位符永远无法满足。
  const SHELL_NAME = /^[A-Z][A-Z0-9_]*$/

  it('/init', async () => {
    await initCmd(fakeCtx(), [])
    const names = envVarsIn(readFileSync(join(MIPHAM_HOME, 'config.yml'), 'utf-8'))

    // 保险丝：正则若失配，下面的循环会零次通过而静默变绿。
    expect(names.length).toBe(CLOUD_PROVIDERS.length)
    for (const n of names) expect(n).toMatch(SHELL_NAME)
  })

  it('/setup 1', async () => {
    useProjectCwd()
    await setupCmd(fakeCtx(), ['1'])
    const names = envVarsIn(readFileSync(join(PROJECT_CWD, '.mipham', 'config.yml'), 'utf-8'))

    expect(names.length).toBe(CLOUD_PROVIDERS.length)
    for (const n of names) expect(n).toMatch(SHELL_NAME)
  })

  it('成功回执里报的变量名与文件里的一致', async () => {
    const result = await initCmd(fakeCtx(), [])
    const names = envVarsIn(readFileSync(join(MIPHAM_HOME, 'config.yml'), 'utf-8'))

    for (const n of names) expect(result.content).toContain(n)
  })
})
