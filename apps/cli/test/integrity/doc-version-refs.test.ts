import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 活文档版本引用守卫（2026-09-28）。
 *
 * 起因：四处**用户会照着做**的指令各自漂到了不同的旧版本 —— `apps/cli/README.md` 的 H1
 * 停在 0.81.7、JetBrains zip 名停在 0.44.0、macOS dmg 名停在 0.21.0、根 `README.md` 的
 * `config.yml` 示例停在 0.83.0 —— 而且**各漂各的**，不是同一时刻一起停的。
 *
 * 根因不是「忘了改」，而是这些站点**没有任何读者**：`scripts/bump-version.sh` 的清单是
 * 固定 7 个文件，而 `published-counts.test.ts` 扫的是**计数**、不扫版本号。改版本号的那一笔
 * 动不了它们，它们又长得跟活文档一样。故修法分两半：把站点接进 `bump-version.sh`（让它们
 * 有写者），再加这道守卫（让漏网的有读者）。
 *
 * 三道臂：
 *   A 活文件令牌表 —— 逐格对上：声明格 == `apps/cli/package.json` 的 version，其余格是
 *     冻结的历史值。用**整表逐格**而不是「逐条正则」是因为同一批文件里混着两类格子
 *     （`README.md` 既有「从 0.85.0 升级」这类**永久**陈述，也有安装输出示例），
 *     只钉声明格会留下「往这个文件里再加一处版本引用」的口子。
 *   B 构建产物名 —— 必须**保持占位**（`<version>` / `<版本>`）。这一臂守的是**反方向**：
 *     有人「顺手」把占位补成具体版本，下一次发布它就漂了 —— 而它本来就不该有值。
 *   C 分类完整性 —— 全仓**已跟踪** `.md` 里的每个版本令牌都必须落在某条分类规则上。
 *     这一条才是根因：下一个人不会知道哪些站点是活声明，但**新出现的文件**会在这里被拦下。
 *
 * **已知边界（如实写，不假装覆盖）**：
 * - 族级规则（`docs/superpowers/` 等）是**前缀**，往族里新加一处**活声明**不会被发现。
 *   判据是「这个族里出现活声明的概率」——计划/规格/技能定义都是点时刻文档。
 * - C 只扫 `git ls-files` 的**已跟踪** `.md`。未跟踪的草稿不在分发面内，也不该被守。
 * - 本文件守的是**形状**（哪个格该等于什么），不是「这句话今天还成立吗」—— 后者是人的判断。
 *
 * 本文件自足（自带 `findRepoRoot`），与 `published-counts.test.ts` 同一约定：
 * 守卫之间不抽公共模块。
 */
function findRepoRoot(from: string): string {
  let dir = from
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`未能在 ${from} 之上找到仓库根（pnpm-workspace.yaml）`)
    dir = parent
  }
}

const CLI_DIR = join(import.meta.dirname, '..', '..')
const REPO_ROOT = findRepoRoot(CLI_DIR)

/** 真源：`apps/cli/package.json` 的 `version`。按字节读盘，不 import。 */
const VERSION = (
  JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf-8')) as { version: string }
).version

/**
 * 版本令牌。
 *
 * 两头都要卡住，否则 `127.0.0.1`（遥测文档里的端口）会当成 `0.0.1` 混进来：
 * - 前面 `(?<![\d.])` —— `127.0.0.1` 里的 `0.0.1` 前面是 `.`，排除；也排除了四段式的中间段。
 * - 后面 `(?!\.?\d)` —— 挡住 `1.2.3.4` 里的 `1.2.3`（后面跟 `.4`），同时**放过**
 *   `mipham-code-jetbrains-0.85.10.zip`（`10` 后面是 `.z`，不是「点 + 数字」）。
 */
const VERSION_TOKEN = /(?<![\d.])v?(\d+\.\d+\.\d+(?:-[\w.]+)?)(?!\.?\d)/g

/** 按**仓库相对路径**读盘；文件不在就抛 —— 分类表指向一个不存在的文件时，红得越早越好。 */
function readFile(rel: string): string {
  const abs = join(REPO_ROOT, rel)
  if (!existsSync(abs)) {
    throw new Error(`分类表里的 ${rel} 不存在 —— 文件被改名或删了，本文件的表要跟着改`)
  }
  return readFileSync(abs, 'utf-8')
}

/** 一个文件里的全部版本令牌，**按出现顺序**。顺序是判据的一部分：换位也要被看见。 */
function tokensOf(rel: string): string[] {
  return [...readFile(rel).matchAll(VERSION_TOKEN)].map((m) => m[1]!)
}

/**
 * A：活文件令牌表。数组顺序 = 文件内出现顺序，`VERSION` 那一格 = 「这里必须等于 package.json」。
 *
 * 冻结格的来历（改它们之前先读这一行）：
 * - `README.md` 的 `0.85.0 / 0.84.0 / 0.85.1` —— 「从某版升级请先别用 `mipham update`」那段
 *   讲的是**当初那个 bug 的影响范围**，它永远是这三个数，不随版本号走。**别顺手 bump 它。**
 * - `apps/cli/README.md` 的 `1.0.0` —— 链到 PRODUCT.md 的**快照标签**，`(v1.0.0, 2026-06-10 snapshot)`。
 * - `infrastructure/vscode/PUBLISH.md` 的 0.81.x —— 「当初 API 滞后一个版本」的实测记录。
 */
const LIVE_FILES: Array<[string, string[]]> = [
  ['README.md', ['0.85.0', '0.84.0', '0.85.1', VERSION, VERSION]],
  ['apps/cli/README.md', [VERSION, '1.0.0']],
  ['infrastructure/jetbrains/README.md', [VERSION]],
  ['infrastructure/macos/README.md', [VERSION]],
  ['infrastructure/vscode/PUBLISH.md', ['0.81.8', '0.81.7', '0.81.9', '0.81.8', '0.81.9']],
]

/**
 * B：构建产物名 —— 这些行里**不该**有具体版本。
 *
 * 正则故意用 `\S+` 而不是 `<version>`：这样有人把它钉成 `-0.86.0.zip` 时，锚**仍然匹配**，
 * 于是下面报的是「出现了具体版本 0.86.0」（说清了错在哪），而不是「找不到站点」（会被误读成
 * 文件被改坏了）。锚匹配不上时另有说法 —— 那时确实是站点被改写或删了。
 */
const GENERIC_ARTIFACTS: Array<{ rel: string; re: RegExp; why: string }> = [
  {
    rel: 'infrastructure/jetbrains/README.md',
    re: /^# Output: build\/distributions\/mipham-code-jetbrains-\S+\.zip$/m,
    why: '构建脚本的输出名 —— 它随版本变，钉死就等于下个版本立刻过期',
  },
  {
    rel: 'infrastructure/macos/README.md',
    re: /^# Output: mipham-code-\S+\.dmg$/m,
    why: '同上（dmg）',
  },
  {
    rel: 'infrastructure/vscode/README.md',
    re: /code --install-extension mipham-code-\S+\.vsix/,
    why: '本地安装命令 —— 用户手上的 vsix 是哪个版本由他自己决定',
  },
  {
    rel: 'infrastructure/vscode/PUBLISH.md',
    re: /unzip -p mipham-code-\S+\.vsix/,
    why: '打包后自检版本的命令',
  },
  {
    rel: 'infrastructure/vscode/PUBLISH.md',
    re: /vsce publish --packagePath mipham-code-\S+\.vsix/,
    why: '发布命令',
  },
]

/**
 * C：族级分类 —— 这些文件里的版本令牌**成群**地是点时刻陈述，逐条列没有信息量。
 * 前缀匹配；`suffix` 用于 `CHANGELOG.md`（三份，其中一份在仓库根）。
 */
const UNRELATED_FAMILIES: Array<{ prefix?: string; suffix?: string; why: string }> = [
  { suffix: 'CHANGELOG.md', why: '变更日志：逐条历史，每个数都是当时那个版本' },
  { prefix: 'docs/superpowers/', why: '计划 / 规格：带日期的点时刻文档' },
  { prefix: 'apps/cli/skills/', why: '技能自身的 frontmatter version（与产品版本无关）' },
  { prefix: 'apps/telemetry/', why: 'nginx 版本号（与产品版本无关）' },
]

/**
 * C：整份文件只有**占位形态**的产物名 —— 由 B 臂独占，C 只把它记为「已分类」。
 *
 * 不这么分的话，两个臂会在同一格上重叠：往这种文件里钉一个具体版本，B 红（正确）
 * 而 C 也红（因为它凭空多出一个令牌、又不在 C 的表里）—— 同一个缺陷报两次，
 * 定位时还得先分辨哪条是真判据。
 */
const PLACEHOLDER_ONLY_FILES = new Map<string, string>([
  ['infrastructure/vscode/README.md', '本地安装命令，整份文件只讲占位名'],
])

/** C：逐个文件分类 —— 单文件成族，或混着多种来历，值得单独给个理由。 */
const FROZEN_FILES = new Map<string, string>([
  ['CLAUDE.md', '活文档，但正文里的版本引用全是对历次发布的陈述；批次的版本标签由文档回填那笔手改'],
  ['ROADMAP.md', '计划与变更记录：逐条历史'],
  ['PRODUCT.md', '点时刻文档（2026-06-10 快照），已被总数守卫豁免'],
  ['MIPHAM.md', '人格定义，其 version 是人格文档自己的版本'],
  ['docs/claude-md-history.md', '修订历史存档：逐条历史'],
  ['docs/slash-commands-audit.md', '当初那次审计的快照（v0.7.9）'],
  ['docs/mipham-code-v0.5.9-wechat-article.md', '介绍 0.5.9 的推广文章'],
  ['docs/telemetry.md', '数据字典，版本号只作示例值（`e.g. 0.81.6`）'],
  ['apps/cli/crsi-lessons.md', '教训清单，版本号出现在叙事里'],
  ['benchmarks/README.md', '基准跑的是当时那个二进制'],
  ['benchmarks/results/README.md', '同上'],
  [
    'SECURITY.md',
    '安全政策：「Accepted advisories」里的版本号是第三方包受影响区间（点时刻快照），不随产品版本走',
  ],
])

describe('活文档的版本引用：逐格对上真源', () => {
  it('真源可取（判据的前提）', () => {
    // 没有这一条，下面「都对上」可能只是因为 VERSION 是空串、而文件里恰好也没扫到东西。
    expect(VERSION, 'package.json 里取不到 version —— 取值路径断了').toMatch(/^\d+\.\d+\.\d+/)
  })

  it('活文件的版本令牌逐条对上（声明格 == package.json，其余格 == 冻结值）', () => {
    const problems: string[] = []
    let slots = 0
    let declarationSlots = 0

    for (const [rel, expected] of LIVE_FILES) {
      const actual = tokensOf(rel)
      slots += expected.length
      declarationSlots += expected.filter((v) => v === VERSION).length
      if (actual.length !== expected.length) {
        problems.push(
          `  ${rel}: 扫到 ${actual.length} 个版本令牌（${actual.join(', ')}），表里是 ${expected.length} 个`,
        )
        continue
      }
      actual.forEach((got, i) => {
        if (got !== expected[i]) {
          problems.push(`  ${rel}: 第 ${i + 1} 格是 ${got}，应为 ${expected[i]}`)
        }
      })
    }

    // 正对照两枚：表非空 + 表里确实有格子指向 package.json 的版本。
    // 少了后者，这道臂就退化成「只比历史值」—— 版本号再怎么漂它都不会红。
    expect(slots, '活文件表是空的 —— 守卫恒真').toBeGreaterThan(0)
    expect(
      declarationSlots,
      '表里没有任何一格 == package.json 的 version —— 这道臂与版本无关了',
    ).toBeGreaterThan(0)

    expect(
      problems.join('\n'),
      `活文档的版本引用与 package.json 不一致：\n${problems.join('\n')}\n\n` +
        `**不要手改** —— 这几处由 \`scripts/bump-version.sh\` 一并改写（跑它）。\n` +
        `若你确实改了这个文件里的版本引用（如删掉一段升级提示），请同步更新本文件的 LIVE_FILES。`,
    ).toBe('')
  })

  it('构建产物名保持占位（不得钉死具体版本）', () => {
    const problems: string[] = []
    let matched = 0

    for (const { rel, re, why } of GENERIC_ARTIFACTS) {
      const m = readFile(rel).match(re)
      if (!m) {
        problems.push(
          `  ${rel}: 找不到 ${re} —— 站点被改写或删了（分类表要跟着改）。原本守的是：${why}`,
        )
        continue
      }
      matched++
      const found = [...m[0].matchAll(VERSION_TOKEN)].map((x) => x[1]!)
      if (found.length > 0) {
        problems.push(`  ${rel}: \`${m[0].trim()}\` 里出现了具体版本 ${found.join(', ')} —— ${why}`)
      }
    }

    expect(matched, '一条产物站点都没匹配上 —— 正则已与文件脱节，下面「全部合规」是空的').toBe(
      GENERIC_ARTIFACTS.length,
    )
    expect(
      problems.join('\n'),
      `构建产物名被钉死了具体版本：\n${problems.join('\n')}\n\n` +
        `这些行**不该**持有版本号 —— 它们随每次发布而变，钉死等于下个版本立刻过期。\n` +
        `正确写法是占位：\`mipham-code-<version>.dmg\` / \`mipham-code-<版本>.vsix\`。\n` +
        `（用户真正要下载的那个文件名不在此列 —— 它在 LIVE_FILES 里，由 bump-version.sh 改写。）`,
    ).toBe('')
  })

  it('全仓已跟踪 .md 的每个版本令牌都被分类', () => {
    // 用 `git ls-files` 而不是遍历工作树：`graft/`（711 个卡片）、`benchmarks/.datasets`、
    // `.superpowers/sdd/` 都被忽略，共 1,700+ 个不该被守的文件；而**已跟踪**才是分发面。
    const files = execFileSync('git', ['ls-files', '-z', '*.md'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    })
      .split('\0')
      .filter(Boolean)
    expect(files.length, 'git ls-files 一个 .md 都没列出 —— 枚举路径断了').toBeGreaterThan(100)

    const classified = new Set<string>([
      ...LIVE_FILES.map(([rel]) => rel),
      ...FROZEN_FILES.keys(),
      ...PLACEHOLDER_ONLY_FILES.keys(),
    ])
    const problems: string[] = []
    let tokens = 0
    let unclassifiedFiles = 0

    for (const rel of files) {
      const inFamily = UNRELATED_FAMILIES.some((f) =>
        f.prefix ? rel.startsWith(f.prefix) : rel.endsWith(f.suffix!),
      )
      if (inFamily) continue
      const found = tokensOf(rel)
      if (found.length === 0) continue
      tokens += found.length
      if (!classified.has(rel)) {
        unclassifiedFiles++
        problems.push(`  ${rel}: ${found.length} 个（${found.slice(0, 3).join(', ')}…）`)
      }
    }

    // 正对照：非族文件里必须真的扫到令牌。0 和「全部分类好了」打印的是同一个字符串。
    expect(
      tokens,
      '非族文件里一个版本令牌都没扫到 —— 扫描路径断了，不是「都已分类」',
    ).toBeGreaterThan(0)
    expect(
      problems.join('\n'),
      `以下文件里有版本引用，但不在分类表里：\n${problems.join('\n')}\n\n` +
        `这不是「必须改掉」—— 是**必须分类**：\n` +
        `- 若是**活声明**（用户会照着做）⇒ 加进 LIVE_FILES，并接进 scripts/bump-version.sh；\n` +
        `- 若是**历史陈述 / 非产品版本 / 点时刻快照** ⇒ 加进 FROZEN_FILES 或 UNRELATED_FAMILIES，并写明理由。`,
    ).toBe('')
    expect(unclassifiedFiles, '分类缺口数与上文行数不符 —— 计数与列表脱节').toBe(problems.length)
  })
})
