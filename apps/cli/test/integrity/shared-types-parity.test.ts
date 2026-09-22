/**
 * 两份 `types.ts` 的机械守卫。
 *
 * `packages/shared/src/types.ts` 是**契约**，`apps/cli/src/shared/types.ts` 是它的
 * **vendor 副本** —— 重复是刻意的（只为 npm 包自包含：运行时不能依赖 workspace 包），
 * 所以不要用「CLI 直接从 `@mipham/shared` re-export」去消掉它，那会在 publish 时崩。
 * 刻意重复的代价必须由守卫来付：`'auto'` 曾**只**落在副本里、契约那边漏了，而
 * **没有任何东西变红** —— 本仓反复栽的「有定义、无施加点」在类型层的同一形状。
 *
 * 断三件事，全部按**声明的成员集合**：
 *  1. 契约里的每个声明，副本里都得有（契约是全集；副本少一个就是漏同步）；
 *  2. 两边都有的声明，成员集合相等（`interface` 比成员名，`type` 别名比字符串字面量）；
 *  3. 只在副本里出现的声明，必须落在下面的**具名豁免表**里（CLI 内部类型，引用活服务）。
 *
 * **已知边界（同 `permission-status-parity.test.ts` 的写法）**：
 * - 只比成员/字面量集合，**不比散文**。散文里的默认值是测不到的 —— `showThinking` 的
 *   「default」在契约里被写成 `minimal`、而代码用 `off`（2026-09-22 同笔修掉），
 *   本守卫**不会**因此变红。别把这里的绿读成「文档是对的」。
 * - `stripComments` 不认字符串字面量里的 `//`（会把 `'http://x'` 截成 `'http:`）。
 *   本文件只取成员名与单引号字面量，且这两个 `types.ts` 里没有含 `//` 的字面量；
 *   真加了 URL 字面量，症状是某个 `type` 别名的字面量集合两边**同时**少一个 ⇒ 仍然相等。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** `apps/cli/`（锚定包目录，同 `permission-status-parity.test.ts`）。 */
const CLI_DIR = join(import.meta.dirname, '..', '..')
const SHARED_TYPES = join(CLI_DIR, '..', '..', 'packages', 'shared', 'src', 'types.ts')
const COPY_TYPES = join(CLI_DIR, 'src', 'shared', 'types.ts')

const read = (p: string): string => readFileSync(p, 'utf8')

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

/** `interface` → 2 空格顶层的成员名；`type` → 单引号字面量。 */
function splitDecls(src: string): Map<string, { kind: string; members: Set<string> }> {
  const clean = stripComments(src)
  const heads = [...clean.matchAll(/^export (interface|type) (\w+)/gm)]
  const out = new Map<string, { kind: string; members: Set<string> }>()
  heads.forEach((h, i) => {
    const name = h[2]
    if (name === undefined) return
    const body = clean.slice(h.index, heads[i + 1]?.index ?? clean.length)
    const grab = (re: RegExp): Set<string> => {
      const s = new Set<string>()
      for (const m of body.matchAll(re)) if (m[1] !== undefined) s.add(m[1])
      return s
    }
    const members = h[1] === 'interface' ? grab(/^ {2}(\w+)\??[:(]/gm) : grab(/'([^']*)'/g)
    out.set(name, { kind: h[1] ?? '', members })
  })
  return out
}

const CONTRACT = splitDecls(read(SHARED_TYPES))
const COPY = splitDecls(read(COPY_TYPES))
const common = [...CONTRACT.keys()].filter((n) => COPY.has(n))

/**
 * 只在副本里的声明 —— CLI 内部类型，**刻意**不共享（引用活服务，见副本末尾的
 * 「CLI 内部类型（引用活服务，不可共享）」分节）。新增一个只在副本里的类型时，
 * 要么把它搬进契约，要么加到这里 —— 这一步是**有意识的决定**，不是摩擦。
 */
const COPY_ONLY = ['SkillDefinition', 'ToolContext', 'ToolDefinition']

describe('两份 types.ts 的成员集合对等', () => {
  it('正对照：两个文件都真的解析出了声明（否则下面是空集上的空话）', () => {
    expect(CONTRACT.size).toBeGreaterThan(40)
    expect(COPY.size).toBeGreaterThan(40)
    // 探针一旦退化（正则写坏、路径写错、stripComments 吃多了），上面两条会先红。
    expect(CONTRACT.get('PermissionMode')?.members).toEqual(
      new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']),
    )
    expect(CONTRACT.get('MiphamConfig')?.members.size).toBeGreaterThan(10)
  })

  it('契约里的每个声明，副本里都有（shared-only 必须为空）', () => {
    expect([...CONTRACT.keys()].filter((n) => !COPY.has(n))).toEqual([])
  })

  it('只在副本里的声明，恰好是具名豁免表里的那几个', () => {
    expect([...COPY.keys()].filter((n) => !CONTRACT.has(n)).sort()).toEqual([...COPY_ONLY].sort())
  })

  it('两边都有的声明，成员集合相等', () => {
    const drift = common
      .filter((n) => !setsEqual(CONTRACT.get(n)!.members, COPY.get(n)!.members))
      .map(
        (n) =>
          `${n}: 契约独有=[${[...CONTRACT.get(n)!.members].sort()}] 副本独有=[${[...COPY.get(n)!.members].sort()}]`,
      )
    expect(drift).toEqual([])
  })

  it('回归锚：2026-09-22 修掉的三处漂移仍在两边（契约漏了这三个）', () => {
    // 这三个曾**只**在副本里：`MiphamConfig` 的两个 UI 偏好与 `HookConfig` 的 timeout。
    // 上一条断言已覆盖；这里点名，是为了让「修过什么」在失败信息里看得见。
    expect([...CONTRACT.get('MiphamConfig')!.members]).toEqual(
      expect.arrayContaining(['showSchedulingNotices', 'showCommandPicker']),
    )
    expect([...CONTRACT.get('HookConfig')!.members]).toContain('timeout')
  })
})

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x))
}
