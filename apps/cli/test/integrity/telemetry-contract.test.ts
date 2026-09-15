/**
 * 跨 app 契约守卫 —— CLI（生产者）与 `apps/telemetry`（接收者）。
 *
 * 这是「契约漂移 ⇒ 静默全丢」的**唯一机械防线**。两个方向都不报错：
 *   - 客户端把一个 payload 字段改名 ⇒ 服务端永远收不到它，只在自己的
 *     `fieldsDropped` 里默默记一笔，而客户端拿到 204 就当成功删了队列；
 *   - 客户端多出一个工具有了标签 ⇒ 服务端的 allowlist 没收录 ⇒ 该工具的所有
 *     调用被折叠进 `__other__`，T4 据此投票时会看到「没人用」。
 * 两者都是「两边都绿、数据没了」，类型检查与各自的测试都看不见。
 *
 * 之所以放在 `apps/cli/test/` 而不是 `apps/telemetry/test/`：注册表真源在 CLI 侧
 * （`createToolRegistry` / `getCommandLabelNames`），放在这里 `apps/telemetry` 的依赖图里
 * 就永远不会有 ink/react。
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { createToolRegistry } from '../../src/tools/index'
import { commandLabelFor, getCommandLabelNames, UNKNOWN_COMMAND } from '../../src/ui/commands'
import { recordCommand, recordToolCall } from '../../src/telemetry/index'
import { buildSessionEvent, COUNTER_WHITELIST, SCHEMA_VERSION } from '../../src/telemetry/payload'
import { buildCrashEvent, recordCrash } from '../../src/telemetry/crash'
import { runtimeTag } from '../../src/telemetry/redact'

const CLI_DIR = join(import.meta.dirname, '..', '..')
const REPO_ROOT = join(CLI_DIR, '..', '..')
const TELEMETRY_DIR = join(REPO_ROOT, 'apps', 'telemetry')
const ALLOWLIST_PATH = join(TELEMETRY_DIR, 'src', 'allowlist.json')

/**
 * 置 1 时重写 allowlist.json 而不是断言。这是唯一的重新生成入口 ——
 * 不另开脚本，免得「生成器」与「校验器」两份逻辑各自漂移。
 */
const UPDATE = process.env.UPDATE_TELEMETRY_ALLOWLIST === '1'

interface AllowlistFile {
  version: number
  generatedFrom: string[]
  labels: Record<string, string[]>
}

/**
 * 从两个注册表推导出服务端应当收录的标签集合。
 *
 * 工具侧用注册表原样。命令侧用 `getCommandLabelNames()` 而非 `getCommandNames()` ——
 * 后者只含注册表键，而 `command_calls` 记的是**用户敲的那个字符串**：`/model-picker`
 * 是用户可敲但未进注册表的别名，`/unknown` 是未注册名的收敛桶。两者都不在
 * `getCommandNames()` 里，漏了它们就会被服务端折叠进 `__other__` —— 而 T4 正是靠
 * 这张表投票，读 `__other__` 等于读「没人用」。
 */
function deriveLabels(): { command_calls: string[]; tool_calls: string[] } {
  const tools = Array.from(createToolRegistry().keys()).sort()
  const commands = getCommandLabelNames()
  return { command_calls: commands, tool_calls: tools }
}

function readAllowlist(): AllowlistFile {
  return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8')) as AllowlistFile
}

describe('遥测契约：接收端 allowlist 与 CLI 注册表不漂移', () => {
  it('allowlist.json 与 createToolRegistry()/getCommandLabelNames() 逐字一致', () => {
    const derived = deriveLabels()

    if (UPDATE) {
      const next: AllowlistFile = {
        version: 1,
        generatedFrom: ['createToolRegistry()', 'getCommandLabelNames()'],
        labels: derived,
      }
      writeFileSync(ALLOWLIST_PATH, JSON.stringify(next, null, 2) + '\n', 'utf-8')
      // Then run the repo's formatter over it. `JSON.stringify` breaks every
      // array one-element-per-line; prettier collapses the short ones back. So
      // without this, regenerating the file leaves `format:check` red and the
      // diff shows a change nobody made — regenerating a generated file must
      // not be able to fail CI.
      execFileSync(join(REPO_ROOT, 'node_modules', '.bin', 'prettier'), ['--write', ALLOWLIST_PATH])
    }

    expect(existsSync(ALLOWLIST_PATH), `${ALLOWLIST_PATH} 不存在`).toBe(true)
    const actual = readAllowlist().labels

    // 断言的是集合而非个数：改名（数量不变）才是最常见的漂移形态。
    expect(actual.command_calls).toEqual(derived.command_calls)
    expect(actual.tool_calls).toEqual(derived.tool_calls)
  })

  it('两份清单都非空 —— 空清单会让每条标签静默折叠进 __other__', () => {
    const derived = deriveLabels()
    expect(derived.command_calls.length).toBeGreaterThan(0)
    expect(derived.tool_calls.length).toBeGreaterThan(0)
  })
})

describe('遥测契约：command_name 的基数在客户端收敛', () => {
  it('未注册的命令名归入 UNKNOWN_COMMAND，不新造序列', () => {
    expect(commandLabelFor('/foobar')).toBe(UNKNOWN_COMMAND)
    expect(commandLabelFor('/telemetry')).toBe('/telemetry')
    // /model-picker 是用户可敲但**不在注册表**里的别名 —— 它在 app.tsx 里被特殊处理。
    // 朴素的 `getCommand(name) === undefined ? unknown : name` 会把它误归桶。
    expect(commandLabelFor('/model-picker')).toBe('/model-picker')
    // 大小写不敏感，与 parseSlashCommand 的 toLowerCase 一致。
    expect(commandLabelFor('/TELEMETRY')).toBe(UNKNOWN_COMMAND)
  })

  it('UNKNOWN_COMMAND 在允许清单里 —— 否则收敛桶自己会被折叠进 __other__', () => {
    expect(getCommandLabelNames()).toContain(UNKNOWN_COMMAND)
  })

  /**
   * 这条是「`PRE_REGISTRY_COMMANDS` 与 app.tsx 各自漂移」的唯一机械防线。
   *
   * app.tsx 里每写一个 `command === '/x'`，就等于新增一个能到达 `recordCommand`
   * 的标签 —— 而那个字面量不在任何注册表里，没有任何别的东西会发现它漏了。
   * 靠约定维护一张必须与另一个文件同步的清单，正是本仓库反复吃过的
   * 「有定义、无施加点」。所以直接扫源码断言。
   */
  it('app.tsx 里特殊处理的每个命令字面量都是合法标签', () => {
    const src = readFileSync(join(CLI_DIR, 'src', 'ui', 'app.tsx'), 'utf-8')
    const literals = Array.from(src.matchAll(/command === '([^']+)'/g), (m) => m[1]!)
    expect(literals.length).toBeGreaterThan(0) // 扫不到就说明正则过期了，别让断言空转
    const known = new Set(getCommandLabelNames())
    const missing = literals.filter((name) => !known.has(name))
    expect(
      missing,
      `app.tsx 特殊处理但这些名字不在 getCommandLabelNames() 里：${missing.join(', ')}`,
    ).toEqual([])
  })
})

describe('遥测契约：接收端的 counter 家族集合与客户端白名单一致', () => {
  it('COUNTER_FAMILIES == COUNTER_WHITELIST 去掉 mipham_code_ 前缀与 _total 后缀', async () => {
    const { COUNTER_FAMILIES } = await import('../../../../apps/telemetry/src/schema')

    const expected = COUNTER_WHITELIST.map((name) =>
      name.replace(/^mipham_code_/, '').replace(/_total$/, ''),
    )

    // 用集合比较，且**双向**：客户端加了计数器而服务端不认（数据被丢），
    // 与服务端留着一个客户端已删除的家族（永远为 0 的死维度），都要红。
    expect([...COUNTER_FAMILIES].sort()).toEqual([...expected].sort())
  })
})

/** 走一遍真实的 JSON 序列化 —— 内存里的对象比线上多出 `undefined` 语意。 */
function overTheWire(event: unknown): unknown {
  return JSON.parse(JSON.stringify(event))
}

describe('遥测契约：真实 payload 能被接收端解析', () => {
  it('buildSessionEvent 的产物 validateEvent ⇒ ok:true，且标签被 allowlist 认出', async () => {
    const { validateEvent } = await import('../../../../apps/telemetry/src/validate')
    const { loadAllowlist } = await import('../../../../apps/telemetry/src/allowlist')

    // 先真的记一次，让 snapshotCounters() 里出现一个有标签的计数器 ——
    // 否则 counters 是空的，标签解析这条路根本没被测到。
    // 工具名用**注册表里的那个键**（首字母大写），不是小写形态：引擎
    // `executeTool(name)` 里的 `name` 就是 `this.tools.get(name)` 的键，
    // 写成小写会让这条测试通过而线上折叠。
    recordCommand('/help')
    recordToolCall('Read')

    const raw = buildSessionEvent({
      installId: '00000000-0000-4000-8000-000000000000',
      startedAt: 0,
      endedAt: 1000,
      crashed: false,
    })

    // 用**真的** allowlist：空 allowlist 会让所有标签折叠，就测不到
    // 「标签能被认出来」这件事，而那正是本文件要守的。
    const result = validateEvent(overTheWire(raw), loadAllowlist(), 'application/json')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.kind).toBe('session')
    if (result.event.kind !== 'session') return

    expect(result.event.schemaVersion).toBe(SCHEMA_VERSION)
    expect(result.notes.unknownSchema).toBe(false)
    // 这两个字段能活下来才算契约真的通 —— 它们正是「静默丢弃」的常见形态。
    expect(result.event.runtime).toBeDefined()
    expect(result.event.platform).toBeDefined()
    expect(result.notes.fieldsDropped).toEqual([])

    // 标签必须在 allowlist 里，否则会被折叠成 __other__。
    expect(result.notes.unknownLabels).toBe(0)
    expect(Object.keys(result.event.counters)).toContain('command_calls./help')
    expect(Object.keys(result.event.counters)).toContain('tool_calls.Read')
  })

  it('注册表里的每个工具名都在 allowlist 里 —— 引擎传的就是这个键', () => {
    const allowlist = readAllowlist().labels.tool_calls ?? []
    const missing = Array.from(createToolRegistry().keys()).filter((n) => !allowlist.includes(n))
    expect(missing, `这些工具会被折叠进 __other__：${missing.join(', ')}`).toEqual([])
  })

  it('MCP 工具名归 __mcp__，未注册的工具名归 __other__ —— 两者不能混', async () => {
    const { validateEvent } = await import('../../../../apps/telemetry/src/validate')
    const { loadAllowlist } = await import('../../../../apps/telemetry/src/allowlist')

    const body = {
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'session',
      payload: {
        installId: '00000000-0000-4000-8000-000000000000',
        schemaVersion: SCHEMA_VERSION,
        runtime: 'node@22',
        platform: 'linux/x64',
        counters: {
          'tool_calls.mcp__obsidian__get_note': 3,
          'tool_calls.NotARealTool': 1,
        },
      },
    }

    const result = validateEvent(body, loadAllowlist(), 'application/json')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    if (result.event.kind !== 'session') throw new Error('expected a session event')

    // MCP 名不可枚举但**属于正常流量** ⇒ 单独一个桶，保住 __other__ 的告警含义。
    expect(result.event.counters['tool_calls.__mcp__']).toBe(3)
    // 未注册的工具名才是真异常 —— 它进 __other__，且不占用前者的桶。
    expect(result.event.counters['tool_calls.__other__']).toBe(1)
  })

  it('buildCrashEvent 的产物 validateEvent ⇒ ok:true 且帧被丢弃', async () => {
    const { validateEvent } = await import('../../../../apps/telemetry/src/validate')
    const { loadAllowlist } = await import('../../../../apps/telemetry/src/allowlist')

    recordCrash(new TypeError('contract probe'), 'uncaughtException')
    const raw = buildCrashEvent('00000000-0000-4000-8000-000000000000')
    expect(raw, 'recordCrash 之后 buildCrashEvent 必须给出事件').not.toBeNull()

    const result = validateEvent(overTheWire(raw), loadAllowlist(), 'application/json')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.kind).toBe('crash')
    if (result.event.kind !== 'crash') return

    expect(result.event.errorName).toBe('TypeError')
    expect(result.event.origin).toBe('uncaughtException')
    expect(result.notes.fieldsDropped).toEqual([])
    // 服务端不留帧，但必须**报告**它收到了多少 —— 否则「发了却必然丢掉」
    // 会退化成「看起来根本没发」。
    expect(result.notes.framesDiscarded).toBeGreaterThan(0)
  })
})

describe('遥测契约：runtime/platform 模式必须接受真实产物', () => {
  /**
   * 这一条是回归守卫，不是形式检查。`runtimeTag()` 对两种运行时**故意不对称**
   * —— Node 只报主版本（`node@22`），Bun 报完整版本（`bun@1.2.3`）。服务端最初的
   * 模式是 `\d+`，于是**只接受 Node 形态、拒绝 Bun 形态**，而 Bun 是本 CLI 推荐的
   * 运行时 ⇒ 多数人群的 `runtime` 维度会被静默丢空，且两边测试全绿。
   * 用真实产物的形状钉住它，而不是我手写的样例。
   */
  it('runtimeTag() 的实际输出被 RUNTIME_PATTERN 接受', async () => {
    const { RUNTIME_PATTERN } = await import('../../../../apps/telemetry/src/schema')

    expect(RUNTIME_PATTERN.test(runtimeTag()), `真实 runtimeTag() = ${runtimeTag()}`).toBe(true)
    // 两种形态都要在，否则这条守卫只在当前运行时上有意义。
    expect(RUNTIME_PATTERN.test('node@22')).toBe(true)
    expect(RUNTIME_PATTERN.test('bun@1.2.3')).toBe(true)
    // 但别宽到把垃圾也收进来。
    expect(RUNTIME_PATTERN.test('node@')).toBe(false)
    expect(RUNTIME_PATTERN.test('deno@1.0')).toBe(false)
  })

  it('platformTag() 的实际输出被 PLATFORM_PATTERN 接受', async () => {
    const { PLATFORM_PATTERN } = await import('../../../../apps/telemetry/src/schema')

    const platform = `${process.platform}/${process.arch}`
    expect(PLATFORM_PATTERN.test(platform), `实际值 = ${platform}`).toBe(true)
  })
})
