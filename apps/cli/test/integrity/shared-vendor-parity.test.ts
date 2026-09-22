/**
 * vendored 族的机械守卫 —— `packages/shared/src/*` 与 `apps/cli/src/shared/*` 的
 * **整族**对等。
 *
 * 这两份重复是**刻意的**：CLI 要发布成自包含的 npm 包，运行时不能依赖 workspace 包
 * （见 `shared-types-parity.test.ts` 头部）。刻意重复的代价必须由守卫来付 —— 2026-09-22
 * 之前，这一族里**只有 `types.ts` 有人守**，另外 4 对全裸着：`constants.ts` 里
 * `'auto'` 曾只在副本中（那次是 types 的字段），而 `mipham-models.json`（模型快照真源）
 * 与 `index.ts` 更是**一个字节都不比**。本文件把整族收进一张表。
 *
 * **按形状分三档**（`Shape`），因为「对等」在这一族里不是一种关系：
 *  1. `byte` —— 无抬头差，**逐字节**相等。这是最强判据：成员集合比不出「值漂移」，
 *     而 `constants.ts` / `mipham-models.json` 的全部价值就在值上（provider baseUrl、
 *     模型 snapshot）。3 对：`constants.ts` / `mipham-models.json` / `index.ts`。
 *  2. `comments-only` —— 只有**文件头注释**合法分叉（CLI 副本写明「编译期常量、随
 *     binary 打进」），正文必须逐字相同。只剥**块注释**，不剥 `//` —— 该文件里没有
 *     `//` 行注释，而 `stripComments` 那类实现会把字符串里的 `//`（URL）一起截掉
 *     （`shared-types-parity.test.ts` 头部记了这条边界）。1 对：`package-info.ts`。
 *  3. `members` —— 正文**合法**多出 CLI 内部声明，只能按声明的成员集合比。1 对：
 *     `types.ts`，由 `shared-types-parity.test.ts` 覆盖，本文件不重复实现它，
 *     只**锚住「它是例外」这个事实**（见 `FAMILY` 表与第四条断言）。
 *
 * **已知边界**：形状 1/2 只看文本，不看语义 —— 两份同时被改成同一个错值（例如两边
 * 一起把某个 baseUrl 写错）本文件**不会**变红，那种缺陷要靠读真源的正确性测试去抓。
 * 别把这里的绿读成「值是对的」。
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** `apps/cli/`（锚定包目录，同两个同族守卫）。 */
const CLI_DIR = join(import.meta.dirname, '..', '..')
const SHARED_DIR = join(CLI_DIR, '..', '..', 'packages', 'shared', 'src')
const COPY_DIR = join(CLI_DIR, 'src', 'shared')

type Shape = 'byte' | 'comments-only' | 'members'

/**
 * 全族 5 对。新增一个 vendored 文件时**必须**加进这张表 —— 加进来是有意识的决定
 * （并当场想清楚它属于哪一档），不是摩擦。
 */
const FAMILY: { file: string; shape: Shape }[] = [
  { file: 'constants.ts', shape: 'byte' },
  { file: 'mipham-models.json', shape: 'byte' },
  { file: 'index.ts', shape: 'byte' },
  { file: 'package-info.ts', shape: 'comments-only' },
  { file: 'types.ts', shape: 'members' },
]

const read = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8')

/** 只剥块注释。**不**碰 `//` —— 见文件头第 2 档的理由。 */
const stripBlockComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, ' ')

/** 差异定位：失败信息必须点名到行，否则「不相等」等于没说。 */
function firstDiff(contract: string, copy: string): string {
  const a = contract.split('\n')
  const b = copy.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `第 ${i + 1} 行：契约=[${a[i] ?? '<无此行>'}] 副本=[${b[i] ?? '<无此行>'}]`
    }
  }
  return '（逐行相同 ⇒ 差异在行尾字符或文件末尾换行）'
}

describe('vendored 族的对等', () => {
  it('正对照：5 对文件两侧都在（路径写错/文件被删时，下面的断言会退化成空话）', () => {
    const missing = FAMILY.flatMap(({ file }) =>
      [
        existsSync(join(SHARED_DIR, file)) ? null : `契约侧缺 ${file}`,
        existsSync(join(COPY_DIR, file)) ? null : `副本侧缺 ${file}`,
      ].filter((x): x is string => x !== null),
    )
    expect(missing).toEqual([])
    expect(FAMILY.length).toBe(5)
    expect(new Set(FAMILY.map((f) => f.file)).size).toBe(FAMILY.length)
  })

  it('形状 byte 的 3 对：逐字节相等', () => {
    const drift = FAMILY.filter((f) => f.shape === 'byte')
      .filter((f) => read(SHARED_DIR, f.file) !== read(COPY_DIR, f.file))
      .map((f) => `${f.file}: ${firstDiff(read(SHARED_DIR, f.file), read(COPY_DIR, f.file))}`)
    expect(drift).toEqual([])
  })

  it('形状 comments-only 的 1 对：剥掉块注释后逐字相等', () => {
    const drift = FAMILY.filter((f) => f.shape === 'comments-only')
      .filter(
        (f) =>
          stripBlockComments(read(SHARED_DIR, f.file)) !==
          stripBlockComments(read(COPY_DIR, f.file)),
      )
      .map(
        (f) =>
          `${f.file}: ${firstDiff(
            stripBlockComments(read(SHARED_DIR, f.file)),
            stripBlockComments(read(COPY_DIR, f.file)),
          )}`,
      )
    expect(drift).toEqual([])
  })

  it('形状 members 的 `types.ts`：例外是**真的**（否则应改判到上面两档）', () => {
    // 这条不是在验 types.ts 的对等（那在 shared-types-parity.test.ts），而是锚住
    // 「它为什么不在本文件里」：一旦它变成了字节相等或只差注释，说明有人把正文也
    // 同步了 ⇒ 应当把它移进上面两档，别再让它挂在例外上。
    const contract = read(SHARED_DIR, 'types.ts')
    const copy = read(COPY_DIR, 'types.ts')
    expect(contract).not.toBe(copy)
    expect(stripBlockComments(contract)).not.toBe(stripBlockComments(copy))
  })
})
