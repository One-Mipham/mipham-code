import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'

/**
 * 未接线文件的处置不能静默腐烂 —— T4 的机械防线。
 *
 * 背景：`rules-loader` 事故（`setRulesLoader` 自 `e2be832` 起只有定义没有调用点、
 * 模块从不加载、持续数月）说明 lint / typecheck / 安全审计**全绿也回答不了
 * 「这文件活着吗」**。T4 用一个四步协议把 12 个 knip 候选过了一遍，结论是
 * **5 条真未接线 + 7 条假报**，每条都要明确决定「删除」或「保留并给理由」。
 *
 * 这条守卫守的是**那个决定本身**：
 *
 *  1. 判为删除的路径必须真的不存在（删了又被谁加回来 ⇒ 红）；
 *  2. 判为保留的路径必须存在，且**仍然**在生产代码里零引用
 *     —— 一旦有人真把它接上了，那条豁免就过期了（陈旧豁免为红），
 *     免得它连同理由一起变成一句谎话；
 *  3. 「生产零引用」是从**磁盘上的 import 图**推出来的，不是读一张手抄清单。
 *
 * ## 为什么豁免写在守卫里而不是 knip.json 的 `ignore`
 *
 * `ignore` 会让 knip **不再报告**这两个文件 —— 可它们确实就是未使用文件，
 * 那是一条**真阳性**。把它按掉等于放弃信号：本仓库已经为「宽 ignore」付过一次
 * 学费（`bin/**` 被忽略直接导致 7 条假报）。knip 保持**报告制**，判决记在这里，
 * 由机器强制。
 *
 * ## 已知的 knip 局限（本文件的 7 条「假报」根因）
 *
 * `knip.json` 的 `ignore` 含 `bin/**`，而 `bin/mipham.ts` 是真实入口且用
 * **动态 `await import()`** 加载依赖（如 `:1204` 的 `../src/vajra/compose`，
 * 供 `--dump-config` 用）。于是所有只经它可达的文件都会被 knip 误报。本守卫
 * 自己解析 import 图（含动态 import 与 `.js` → `.ts` 写法），因此不受此限 ——
 * 下面 `REACHABLE_BUT_KNP_REPORTS` 记录的正是这批。
 */

const CLI_DIR = join(import.meta.dirname, '..', '..')
const SRC_DIR = join(CLI_DIR, 'src')
const BIN_DIR = join(CLI_DIR, 'bin')

/** 判为**删除**：生产零引用 + 功能已被现有模块取代。路径必须不存在。 */
const DELETED: Array<{ path: string; why: string }> = [
  {
    path: 'src/core/task-runner.ts',
    why: '已被 core/task-performance.ts（LLM 生成代码 → 冻结测试判定 → 分数）取代',
  },
  { path: 'src/core/task-runner-tasks.json', why: '上者的专属数据文件，随它一起去' },
  {
    path: 'src/skills/standard/runtime.ts',
    why: '双轨运行时：自 v0.1.0（27609bf）起生产零引用，skills/loader.ts 从不加载它',
  },
  { path: 'src/skills/mipham/runtime.ts', why: '同上（另一条轨）' },
  { path: 'test/core/task-runner.test.ts', why: '被测模块已删，测试不能独自留下' },
]

/**
 * 判为**保留**：有明确用途，但不接生产。必须存在且生产零引用。
 *
 * 允许**临时**条目（「还没接」而非「不打算接」）：新文件一旦生产零引用就该被
 * 看见，而第 2 条规则（保留项被接上 ⇒ 陈旧豁免为红）就是它的到期机制 ——
 * 接线者会被测试直接点名要求撤掉本行。临时条目须在 `why` 里写明去向。
 */
const KEPT_UNWIRED: Array<{ path: string; why: string }> = [
  {
    path: 'src/vajra/leaf/plan-runner.ts',
    why: 'Vajra 内核「真叶子」的能力证明（SDD 编排作为内核 Service）；profile-driven live startup 按 M3 决策有意不接，生产无调用者',
  },
  {
    path: 'src/providers/llm-replay.ts',
    why: 'provider-swap 的测试基础设施（record/replay），是 test/core/engine.test.ts 证明 ctx.llm 可换的唯一支撑 —— 它是测试夹具，不是死代码',
  },
]

/**
 * 判为**保留**但**方法级**未接线：文件被接了，方法没被接。
 *
 * 上面那条「零引用集合」断言守的是**文件**，所以一个**一半接线**的文件在它眼里是绿的。
 * `src/security/gate.ts` 正是这种：`redactCredentialLeak` 有两个生产调用点
 * （`core/behavior-tasks.ts`、`core/credential-masker/output-scrub.ts`）⇒ 文件可达 ⇒
 * 另外三个 `static` 方法**生产零调用**却无人过问。它们的唯一消费者是
 * `test/security/penetration/`，而 CI 的 `penetration-test` job 是绿的 ——
 * **读起来像「生产有这些防线」，实际只是「这几个判定函数被自己测过」。**
 *
 * 粒度错了：守的是文件，漏的是导出。
 *
 * 下面每条都在此登记**去路**，并由机器两向强制（存在 + 生产零引用）。
 * `why` 要写清「为什么不接」，否则下一个人会把它当缺口重新报一遍。
 */
const KEPT_UNWIRED_METHODS: Array<{ file: string; symbol: string; why: string }> = [
  {
    file: 'src/security/gate.ts',
    symbol: 'checkPathTraversal',
    why: '被更强的生产防线取代：`security/path.ts resolveSafe` 做规范化 + realpath + isWithin 包含判定，已接进 read/write/edit/glob 四个文件工具（`test/security/path.test.ts` 覆盖 `../../../etc/passwd`）。此处只做字符串层面 `..` / `%2e%2e` 匹配，接上去只会多一道更弱、可绕过的门。',
  },
  {
    file: 'src/security/gate.ts',
    symbol: 'checkBashCommand',
    why: '生产的 bash 危险命令防线是 `core/crsi-managed-rules.ts` 的 managed 规则（`MANAGED_DANGEROUS_RE`，8 条行为缺口，eval 冻结判定）+ permission 层。本方法的 4 条正则与之不一致且更窄（`;\\s*(rm|cat|sh|bash)` 会拦掉 `ls; cat file` 这类正常链式命令）⇒ 接上等于双门不同判据。',
  },
  {
    file: 'src/security/gate.ts',
    symbol: 'checkPromptInjection',
    why: '**有意不接**。它的输入面是**用户自己敲的字**，子串匹配必然误伤（用户贴一份提示注入报告、或问「ignore previous instructions 是什么意思」都会被拦）。本仓库对提示注入的防线是红队 + eval harness（`/crsi red-team`、`core/eval-harness.ts` 冻结契约），不是输入子串门。',
  },
]

/**
 * 同一文件里**确实已接线**的导出 —— 用来证明上面那条扫描抓得住引用。
 * 没有它，「零引用」既可能真是零引用，也可能是扫描根本不会命中（同形）。
 */
const WIRED_SIBLING = { file: 'src/security/gate.ts', symbol: 'redactCredentialLeak' }

/**
 * knip 报「未使用」但经 `bin/mipham.ts` 实际可达 —— 记在这里是为了让这 7 条
 * 有名字，而不是每次跑 knip 都重新困惑一遍。本守卫的 import 图判定会把它们
 * 算作**可达**，所以「生产零引用集合 == KEPT_UNWIRED」这条断言不会误伤它们。
 */
const REACHABLE_BUT_KNP_REPORTS = [
  'src/shared/arg-validation.ts',
  'src/shared/deleted-cwd.ts',
  'src/vajra/compose/assemble.ts',
  'src/vajra/compose/bundle.ts',
  'src/vajra/compose/dump.ts',
  'src/vajra/compose/index.ts',
  'src/vajra/compose/mount.ts',
]

/** 递归收集 src/ 与 bin/ 下的源码文件（守卫自己走盘，不依赖 knip）。 */
function sourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(p)
  }
  return out
}

/** `from '...'` 与动态 `import('...')` 两种写法都要抓。 */
const SPECIFIER = /(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g

/**
 * 把相对说明符解析回磁盘路径。`./x.js` 必须认，因为本仓库的 ESM 写法会带 `.js`
 * 后缀而真实文件是 `.ts` —— 漏掉这一步，图会少一大片边，于是「零引用」变成
 * **假阴性**：一个其实活着的模块会被判成未接线（本仓库踩过「计数管道静默说谎」）。
 */
function resolveSpecifier(spec: string, importer: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = normalize(join(dirname(importer), spec))
  const stems = [base]
  if (base.endsWith('.js')) stems.push(base.slice(0, -3))
  else if (base.endsWith('.jsx')) stems.push(base.slice(0, -4))
  for (const s of stems) {
    // `s` 本身也算候选：本仓库有些说明符**带真实扩展名**（`from '../../core/paths.ts'`），
    // 只试补后缀的话会去找 `paths.ts.ts`、什么都不匹配 —— 于是「零引用」变成假阴性，
    // 一个活得好好的模块被判成未接线。（本守卫第一版正是这么错的，被它自己的
    // 「集合相等」断言抓出来。）
    for (const c of [`${s}.ts`, `${s}.tsx`, join(s, 'index.ts'), join(s, 'index.tsx'), s]) {
      if (!existsSync(c) || !statSync(c).isFile()) continue
      if (c.endsWith('.ts') || c.endsWith('.tsx')) return normalize(c)
    }
  }
  return null
}

const FILES = [...sourceFiles(SRC_DIR), ...sourceFiles(BIN_DIR)]

/**
 * 一次遍历建好 import 反查表：`目标绝对路径 → 引用它的生产文件`。
 *
 * 第一版是「每个候选都把所有文件重读一遍」，在整套并发跑的时候 O(n²) 直接撞穿
 * 5s 超时 —— 守卫自己成了套件里的不稳定项。这里读一次、建一张表。
 */
const IMPORTERS = new Map<string, string[]>()
for (const f of FILES) {
  const self = relative(CLI_DIR, f)
  for (const m of readFileSync(f, 'utf-8').matchAll(SPECIFIER)) {
    const spec = m[1]
    if (!spec) continue
    const target = resolveSpecifier(spec, f)
    if (!target) continue
    const list = IMPORTERS.get(target) ?? []
    if (!list.includes(self)) list.push(self)
    IMPORTERS.set(target, list)
  }
}

/** 生产代码里「谁 import 了它」的集合（不含 test/ —— 测试引用不算接线）。 */
function productionImporters(target: string): string[] {
  const want = normalize(join(CLI_DIR, target))
  // 自引用不算：一个文件 import 自己不是接线。
  return (IMPORTERS.get(want) ?? []).filter((p) => p !== relative(CLI_DIR, want)).sort()
}

/**
 * 生产代码里「谁**提到**了这个符号」—— 方法级接线判定，比 import 图细一格。
 * 定义它的那个文件不算（自引用不是接线）。`\b` 两侧夹住，避免 `checkBashCommandX`
 * 这种前缀命中被误算成引用。
 */
function referencesOutside(relPath: string, symbol: string): string[] {
  const self = normalize(join(CLI_DIR, relPath))
  const re = new RegExp(`\\b${symbol}\\b`)
  return FILES.filter((f) => f !== self)
    .filter((f) => re.test(readFileSync(f, 'utf-8')))
    .map((f) => relative(CLI_DIR, f))
    .sort()
}

describe('T4 未接线文件的处置有守卫', () => {
  it('判为删除的路径必须不存在（删掉的东西不许悄悄回来）', () => {
    expect(DELETED.length).toBeGreaterThan(0)
    const resurrected = DELETED.filter((d) => existsSync(join(CLI_DIR, d.path))).map((d) => d.path)
    expect(resurrected).toEqual([])
    // 两条 runtime 的**目录**也应随之一并消失，别留空壳。
    for (const dir of ['src/skills/standard', 'src/skills/mipham']) {
      expect(existsSync(join(CLI_DIR, dir)), `${dir} 应是空壳，应已删除`).toBe(false)
    }
  })

  it('判为保留的路径必须存在', () => {
    const missing = KEPT_UNWIRED.filter((k) => !existsSync(join(CLI_DIR, k.path))).map(
      (k) => k.path,
    )
    expect(missing).toEqual([])
  })

  it('保留项仍须生产零引用 —— 一旦被接上，这条豁免就过期了', () => {
    // 空转守卫：图没建起来的话，下面每条都会零次通过。
    expect(FILES.length).toBeGreaterThan(100)
    for (const k of KEPT_UNWIRED) {
      expect(productionImporters(k.path), `${k.path} 已被接线，请撤掉豁免`).toEqual([])
    }
  })

  it('生产零引用的集合恰好等于保留表 —— 新冒出的未接线文件不会溜过', () => {
    // 只扫「有导出」的模块（纯常量/类型文件不在本协议的处置范围内）。
    const candidates = FILES.filter((f) => relative(CLI_DIR, f).startsWith('src/')).filter((f) =>
      /^export\s+(class|function|const)\s/m.test(readFileSync(f, 'utf-8')),
    )
    const unwired = candidates
      .filter((f) => productionImporters(relative(CLI_DIR, f)).length === 0)
      // 入口不算「未接线」：它们本来就是被外部（二进制 / bin 包装）调起的。
      .map((f) => relative(CLI_DIR, f))
      .filter((p) => !/(^src\/index\.tsx$|^src\/daemon\/index\.ts$)/.test(p))
      .sort()

    expect(unwired).toEqual(KEPT_UNWIRED.map((k) => k.path).sort())
  })

  it('7 条 knip 假报确实经 bin/ 可达（记录在案，免得每次重新困惑）', () => {
    expect(REACHABLE_BUT_KNP_REPORTS.length).toBe(7)
    for (const p of REACHABLE_BUT_KNP_REPORTS) {
      expect(existsSync(join(CLI_DIR, p)), `${p} 不存在了，请更新这张表`).toBe(true)
      expect(productionImporters(p).length, `${p} 应为可达`).toBeGreaterThan(0)
    }
  })

  it('判为保留的**方法**必须存在，且仍须生产零引用', () => {
    expect(KEPT_UNWIRED_METHODS.length).toBeGreaterThan(0)
    for (const m of KEPT_UNWIRED_METHODS) {
      const text = readFileSync(join(CLI_DIR, m.file), 'utf-8')
      // 必须用 `\b` 夹住的**整名**判定：`toContain` 是子串匹配，把 `checkPathTraversal`
      // 改名成 `checkPathTraversalRenamed` 后它照样命中 ⇒ 这条断言会在符号早已不存在时
      // 依然全绿（本守卫的第一版正是如此，靠负控才发现）。
      expect(
        new RegExp(`\\b${m.symbol}\\b`).test(text),
        `${m.symbol} 不在 ${m.file} 里，请更新这张表`,
      ).toBe(true)
      expect(referencesOutside(m.file, m.symbol), `${m.symbol} 已被接线，请撤掉豁免`).toEqual([])
    }
  })

  it('方法级扫描确实抓得住引用（正对照）—— 否则上面那条「零引用」是仪式', () => {
    // 同一个文件里已接线的兄弟导出：扫描必须能命中它。
    const refs = referencesOutside(WIRED_SIBLING.file, WIRED_SIBLING.symbol)
    expect(
      refs.length,
      `${WIRED_SIBLING.symbol} 应为已接线，扫描却没命中 — 判据本身坏了`,
    ).toBeGreaterThan(0)
    // 反向：一个**不存在**的符号名必须零命中，证明扫描不是「什么都不返回」。
    expect(referencesOutside(WIRED_SIBLING.file, 'noSuchSymbolAnywhereZzz')).toEqual([])
  })

  it('解析器认得 `.js` → `.ts` 的写法（认不得则「零引用」是假阴性）', () => {
    const importer = join(SRC_DIR, 'index.tsx')
    expect(resolveSpecifier('./core/engine', importer)).toBe(
      normalize(join(SRC_DIR, 'core', 'engine.ts')),
    )
    // 本仓库的 ESM 写法：说明符带 .js，真实文件是 .ts。
    expect(resolveSpecifier('./core/engine.js', importer)).toBe(
      normalize(join(SRC_DIR, 'core', 'engine.ts')),
    )
    // 包依赖不该被当成相对路径解析。
    expect(resolveSpecifier('node:fs', importer)).toBeNull()
  })
})
