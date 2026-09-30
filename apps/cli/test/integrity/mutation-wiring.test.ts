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
 * 有意延后到第二批的文件 —— 现为**空**（2026-09-15 第二批落地，`crsi-sandbox.ts` 已接入）。
 *
 * 这张表保留成空数组而不是删掉：它的价值是**形状**，不是内容 —— 下次真要延后谁，
 * 往这里加一项即被守卫可见地记下，而不是让 `mutate` 悄悄少一个文件。
 *
 * **第一批的延后理由已被实测证伪，逐字记在这里免得有人照着它再延一次**：当时的判断是
 * 「`runTests()` 会在临时 worktree 里 `execSync('pnpm test')` 跑整套套件，每个踩到该路径的
 * 变异体都要付一次全量」，听起来无懈可击 —— 但它默认了**有人覆盖那条路径**。实际是：
 * `runTests()` 的唯一生产调用点 `crsi-modify.ts:92` 在 `crsi-modify.test.ts` 里被 6 处
 * `vi.spyOn(sandbox, 'runTests').mockReturnValue(...)` 整个 mock 掉，`crsi-sandbox.test.ts`
 * 也从不调用它 ⇒ `runTests()` 体内（360–425 行）的变异体全部落 `NoCoverage`，
 * 而 Stryker 对 no-coverage 变异体**什么都不跑**。
 *
 * 真正的成本在别处且可承受：`crsi-sandbox.test.ts` 在约 20 处**真的 `git worktree add`**
 * （30s 超时）；干跑实测 423 变异体、初始跑 169 测试 / 8 秒 / 退出码 0。
 * 教训与 `rules-loader` / 双轨 Runtime 同源：**「这机制的代价」要先查「谁在用它」**。
 */
const DEFERRED_TO_BATCH_2: string[] = []

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

// ── 器材补丁：跑手 `@stryker-mutator/vitest-runner` 上的那个补丁 ─────────────────
//
// 上游用 `nameParts.join(' ')` 拼测试名，而 vitest 5 报上来的是 `套件 > 用例` 这种
// 分层名 ⇒ 名字对不上，Stryker 判定「没有测试覆盖这个变异体」，于是**一个测试都不跑**。
// 分数照常打印，量的却是器材（本仓旧的三套读数就是这么废掉的）。
// 修法落在根 `package.json` 的 `pnpm.patchedDependencies` + `patches/*.patch`。
//
// 这条链最脆的一环：`pnpm` 只在**补丁文件没了**时 fail-closed，**声明被删**它一声不响
// —— 删掉声明再 `pnpm install`，锁文件里的补丁记录一并消失、补丁不再应用，而症状是
// 「分数变低」这个**看起来像结果的东西**。整个过程没有任何红灯：`--frozen-lockfile`
// 那时也自洽（锁文件与清单都没了同一条）。所以下面钉住三段：声明、补丁文件、以及
// `apps/cli` **实际解析到的那一份文件内容** —— 只有最后一段是终点，前两段是它的原因。

const REPO_ROOT = join(CLI_DIR, '..', '..')
const ROOT_MANIFEST = join(REPO_ROOT, 'package.json')
const RUNNER_PKG = '@stryker-mutator/vitest-runner'

interface PatchDiff {
  /** 目标在包内的相对路径（`+++ b/<path>` 里那一段）。 */
  file: string
  /** 补丁要换掉的原行（`-`）与换上去的新行（`+`）。 */
  removed: string[]
  added: string[]
}

/**
 * 从 unified diff 里取出「换了哪几行」。
 *
 * 判据**派生**自补丁文件本身，不另抄一份：补丁既是施加物、也是期望值的来源，改了补丁
 * 守卫自动跟上（抄一份的话，改补丁而忘了改守卫，两处会一起骗人）。
 * 空行不成判据 —— `toContain('')` 恒真，「探针缺席」与「探针通过」同形。
 */
function patchDiffs(src: string): PatchDiff[] {
  const diffs: PatchDiff[] = []
  for (const raw of src.split('\n')) {
    if (raw.startsWith('+++ ')) {
      diffs.push({ file: raw.slice('+++ b/'.length).trim(), removed: [], added: [] })
      continue
    }
    const cur = diffs.at(-1)
    if (!cur || raw.startsWith('--- ')) continue
    if (raw.startsWith('-')) cur.removed.push(raw.slice(1))
    else if (raw.startsWith('+')) cur.added.push(raw.slice(1))
  }
  return diffs.map((d) => ({
    ...d,
    removed: d.removed.filter((l) => l.trim() !== ''),
    added: d.added.filter((l) => l.trim() !== ''),
  }))
}

const PATCHES =
  (
    JSON.parse(readFileSync(ROOT_MANIFEST, 'utf-8')) as {
      pnpm?: { patchedDependencies?: Record<string, string> }
    }
  ).pnpm?.patchedDependencies ?? {}
const RUNNER_PATCH_KEY = Object.keys(PATCHES).find((k) => k.startsWith(`${RUNNER_PKG}@`))
const RUNNER_PATCH = RUNNER_PATCH_KEY ? join(REPO_ROOT, PATCHES[RUNNER_PATCH_KEY]!) : undefined

describe('变异跑手的补丁还生效（声明 → 补丁文件 → 真装上的那一份）', () => {
  it('根 package.json 仍声明着这条补丁，且补丁文件在盘上', () => {
    // 删掉声明这个动作本身没有任何反馈：下一次 `pnpm install` 会顺手把锁文件里的
    // 补丁记录也抹掉，此后装的跑手就是**干净的上游版**。
    expect(
      RUNNER_PATCH_KEY,
      `根 package.json 的 pnpm.patchedDependencies 里找不到 ${RUNNER_PKG} 的条目`,
    ).toBeDefined()
    expect(existsSync(RUNNER_PATCH!), `${RUNNER_PATCH!} 不存在`).toBe(true)
  })

  it('补丁文件自己提供了判据（每个目标都有可判的原行与新行）', () => {
    // 空转守卫：解析出零条 diff、或判据行被滤空，下面那组内容断言会**零次通过**
    // —— 那与「补丁生效」同形。
    const diffs = patchDiffs(readFileSync(RUNNER_PATCH!, 'utf-8'))
    expect(diffs.length).toBeGreaterThan(0)
    for (const d of diffs) {
      expect(d.removed.length, `${d.file} 没有可判的原行`).toBeGreaterThan(0)
      expect(d.added.length, `${d.file} 没有可判的新行`).toBeGreaterThan(0)
    }
  })

  it('apps/cli 解析到的那一份真的打了补丁', () => {
    // 落到**文件内容**：这条链的终点是 Stryker 实际 require 的那份 js。
    // 路径与运行时同源（`apps/cli/node_modules/...`，pnpm 的 `patch_hash` 变体）；
    // 不去 glob `.pnpm/` —— 那里可能同时躺着**没打补丁的另一份**，glob 会看错对象。
    const pkgDir = join(CLI_DIR, 'node_modules', RUNNER_PKG)
    expect(existsSync(pkgDir), `${pkgDir} 不存在 —— 先跑 pnpm install`).toBe(true)
    for (const d of patchDiffs(readFileSync(RUNNER_PATCH!, 'utf-8'))) {
      const src = readFileSync(join(pkgDir, d.file), 'utf-8')
      for (const line of d.removed) {
        expect(src, `${d.file} 里仍有「${line.trim()}」—— 补丁没生效`).not.toContain(line)
      }
      for (const line of d.added) expect(src).toContain(line)
    }
  })
})
