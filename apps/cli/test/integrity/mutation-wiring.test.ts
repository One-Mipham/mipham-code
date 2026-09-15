import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 变异测试的范围不能静默腐烂。
 *
 * 本仓库对门禁的硬要求是「配置 + 施加点」，这一条守的是**范围**本身。变异跑不进 CI
 * （一次八分钟，塞进 push 会变成被习惯性忽略的门禁），所以它的配置在两次手动运行之间
 * 没有任何东西看着 —— 而这正是最容易烂的地方：`mutate` 被改成空数组、被收窄成一个
 * 文件、或者 `src/core/` 下新加的安全模块没人想起来加进去，全都是**悄无声息**的，
 * 症状是分数照样好看而覆盖面已经没了。
 *
 * 因此这里断言的是**从磁盘上推导出来的集合**，不是从配置里读回来的集合：
 * 凡是落在 ROADMAP 规定范围内（`src/core/crsi-*` + `src/core/permission*`）的文件，
 * 要么在 `mutate` 里，要么在下面这张**有名字、有理由**的延后表里。加一个新文件而
 * 忘了接进来 ⇒ 这条守卫红。
 *
 * 配置是 JSON 且用 `JSON.parse` 读，所以不存在「注释里写着 mutate」这种假阳性 ——
 * 本文件不做任何文本匹配（`coverage-wiring.test.ts` 需要剥注释，是因为它读的是
 * `vitest.config.ts` 的源码文本）。
 */

const CLI_DIR = join(import.meta.dirname, '..', '..')
const CONFIG_PATH = join(CLI_DIR, 'stryker.config.json')
const MANIFEST_PATH = join(CLI_DIR, 'package.json')
const CORE_DIR = join(CLI_DIR, 'src', 'core')

interface StrykerConfig {
  testRunner?: string
  plugins?: string[]
  coverageAnalysis?: string
  mutate?: string[]
  thresholds?: { high?: number; low?: number; break?: number | null }
}

interface Manifest {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as StrykerConfig
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Manifest
const MUTATE = CONFIG.mutate ?? []

/**
 * ROADMAP 规定的范围（`ROADMAP.md` 的 T3c 条目：`src/core/crsi-*` + `src/core/permission*`）。
 * 从磁盘枚举而不是把七个文件名抄一遍：抄一遍的话，新加的 `src/core/permission-*.ts`
 * 会永远逃过变异测试，而配置和这条断言看起来都毫无问题。
 */
const IN_SCOPE = readdirSync(CORE_DIR)
  .filter((f) => f.endsWith('.ts') && (f.startsWith('crsi-') || f.startsWith('permission')))
  .sort()

/**
 * 有意延后到第二批的文件 —— 理由见 ROADMAP 的 T3c 落地结果段。
 *
 * `crsi-sandbox.ts:368` 的 `runTests()` 会在临时 worktree 里跑**整套**测试
 * （`execSync('pnpm test')`，120s 超时），踩到该路径的每个变异体都要付一次全量套件
 * （现约 2525 个测试），足以独自吃光整个预算，且跑动期间反复动真仓库。
 * 这张表是要**明写**的：多一个文件悄悄溜进来由这条守卫拦下，而不是靠谁记得。
 */
const DEFERRED_TO_BATCH_2 = ['crsi-sandbox.ts']

/**
 * `mutate` 的每一项都必须是**平铺路径**。
 *
 * 这条不是洁癖：下面用的是集合相等，而 `src/core/*.ts` 这样的 glob 或
 * `!src/core/crsi-sandbox.ts` 这样的取反都会让「集合」变成无界或减法，
 * 于是相等断言照样通过而实际范围早已不是那份清单。
 */
function isPlainPath(entry: string): boolean {
  return !entry.startsWith('!') && !/[*?[\]{}]/.test(entry)
}

describe('变异测试的范围与配置有守卫', () => {
  it('能读到配置与清单，且范围内的文件确实被枚举到', () => {
    expect(existsSync(CONFIG_PATH)).toBe(true)
    expect(existsSync(MANIFEST_PATH)).toBe(true)
    // 空转守卫：枚举为空的话，下面每条集合断言都会零次通过。
    expect(IN_SCOPE.length).toBeGreaterThan(0)
    expect(MUTATE.length).toBeGreaterThan(0)
    expect(IN_SCOPE).toEqual(
      expect.arrayContaining(['crsi-producer.ts', 'permission-config.ts', 'permission.ts']),
    )
  })

  it('mutate 里没有 glob、没有取反 —— 否则集合相等就不再意味着范围相等', () => {
    expect(MUTATE.filter((e) => !isPlainPath(e))).toEqual([])
  })

  it('mutate 指向的文件都真实存在', () => {
    expect(MUTATE.filter((rel) => !existsSync(join(CLI_DIR, rel)))).toEqual([])
  })

  it('mutate 恰好覆盖 ROADMAP 规定的范围，只差明写的那份延后表', () => {
    const mutated = MUTATE.map((rel) => rel.replace(/^src\/core\//, '')).sort()
    const missing = IN_SCOPE.filter((f) => !mutated.includes(f))

    // 集合相等：漏接一个新文件 ⇒ missing 多一项；多接范围外的文件 ⇒ 第二个断言红。
    expect(missing).toEqual(DEFERRED_TO_BATCH_2)
    expect(mutated.filter((f) => !IN_SCOPE.includes(f))).toEqual([])
  })

  it('package.json 有 mutate 脚本，且真的在跑 stryker', () => {
    const script = MANIFEST.scripts?.['mutate'] ?? ''
    expect(script).toMatch(/\bstryker\b/)
    // `run` 是必需的子命令：没有它 stryker 只会打印 help 并以 0 退出 —— 又是一次
    // 「有定义、无施加点」，而且退出码还是绿的。
    expect(script).toMatch(/\bstryker\s+run\b/)
  })

  it('stryker 两个包都是 devDependency，不进生产依赖树、不进发布产物', () => {
    const deps = MANIFEST.dependencies ?? {}
    const devDeps = MANIFEST.devDependencies ?? {}
    for (const pkg of ['@stryker-mutator/core', '@stryker-mutator/vitest-runner']) {
      expect(devDeps[pkg], `${pkg} 应在 devDependencies`).toBeDefined()
      expect(deps[pkg], `${pkg} 不得进 dependencies`).toBeUndefined()
    }
    // plugins 里声明的必须就是已装的那个 vitest runner，且 testRunner 与它配套。
    expect(CONFIG.testRunner).toBe('vitest')
    expect(CONFIG.plugins).toEqual(['@stryker-mutator/vitest-runner'])
  })

  it('基线期不设 break 阈值；perTest 分析器要在（成本的主要杠杆）', () => {
    // 分数未知前设阈值是赌博，且会让本地按需运行随时变红 —— 决策见 ROADMAP。
    // 将来要上棘轮时，这里与 stryker.config.json 一起改，改就是一次显式动作。
    expect(CONFIG.thresholds?.break ?? null).toBeNull()
    // `all` 会让每个变异体重跑整套测试；`perTest` 只跑覆盖它的那些（实测均 12 个）。
    expect(CONFIG.coverageAnalysis).toBe('perTest')
  })

  it('检测器认得出平铺路径与 glob/取反的区别', () => {
    expect(isPlainPath('src/core/permission.ts')).toBe(true)
    // 取反项单看也是一条「路径」，但它表达的是减法，不是集合成员。
    expect(isPlainPath('!src/core/crsi-sandbox.ts')).toBe(false)
    expect(isPlainPath('src/core/*.ts')).toBe(false)
    expect(isPlainPath('src/core/permission-?.ts')).toBe(false)
    // 花括号展开同样会把「相等」变成「无界」。
    expect(isPlainPath('src/core/{permission,crsi}-x.ts')).toBe(false)
  })
})
