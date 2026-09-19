/**
 * 引用完整性守卫 —— 抓住「引用了不存在的东西，且没有守卫能抓」这一类缺陷。
 *
 * 本仓库已发生四次同类事故，共同点都是**引用方与被引用方分处不同文件**，
 * 于是类型检查与既有测试都看不见：
 *   1. `core/rules-loader.ts` 只定义不接线（`setRulesLoader` 全仓库零调用点）
 *      （**现已于 2.37.3 接线**；daemon 侧是同类残留，由 `daemon-capability-parity.test.ts`
 *      在 T5 收口 —— 这条留着是因为它记的是**缺陷类**，不是某个文件的历史状态）
 *   2. 内置 `superpower` skill 残留上游技能名（`brainstorming` / `mcp-builder` 等）
 *   3. VS Code 扩展注入 `MIPHAM_IDE` 环境变量，CLI 侧零消费者
 *   4. `/todos` 的提示词、参考表与 locale 文案引用 `TaskCreate` / `TaskList` 等
 *      不存在的工具名（真实工具只有一个 `Task`，动作走 `action` 参数）
 *
 * 本文件用五段机器可校验的契约：前四段覆盖上述缺陷类，第五段守的是文档体积与
 * 两张变更记录表的**去向**（CLAUDE.md 拆分后 17 小时内又长回 56k，约定此前只存在于
 * 记忆里、未落到纸面也无人守；2026-09-19 起两表整体移出，正文只留指针）。守卫的价值取决于**不误报**——
 * 实测（2026-09-15）扫描命中 6 个幻影名（分布在 10 处），误报 0；被排除的合法词
 * `GitHub` / `GitLab` / `ConfigChange` 见 ALLOWED_NON_TOOL_WORDS。误报的处理方式是
 * **加白名单并写明理由**，不是放宽规则、更不是删掉守卫。
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createToolRegistry } from '../../src/tools/index'

/**
 * 向上走到仓库根（以 `pnpm-workspace.yaml` 为锚），而不是数 `..` 的层数。
 *
 * 数层数只在「本文件恰好处在真实树里那个深度」时成立，而这个前提并不牢靠：
 * Stryker 把整个包复制到 `apps/cli/.stryker-tmp/sandbox-N/` 里跑测试，文件比真实树
 * **深一层**，于是原本的 `join(CLI_DIR, '..', '..')` 会停在 `apps/cli` 而不是仓库根。
 * 以标记文件为锚则与嵌套深度无关。本文件自带此函数而不抽公共模块，是全仓库守卫
 * 一贯的约定（每个守卫文件自足）。
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

/** 扫描面 = `src/` + `bin/`，含 `.json`。locale JSON 必须在内，见下。 */
const SCAN_ROOTS = [join(CLI_DIR, 'src'), join(CLI_DIR, 'bin')]
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.json']

/**
 * 形如「已注册工具名 + 大写开头的后缀」但不是已注册工具名的词。
 * 这类词是真正的危险信号：它长得像工具名，模型和人都会当成工具名去调用。
 * 其余 CamelCase 词（`Mipham`、`JsonSchema` 之类）不在此列，故不报。
 */
const ALLOWED_NON_TOOL_WORDS = new Map<string, string>([
  ['GitHub', '服务商名，前缀恰好撞上 Git 工具'],
  ['GitLab', '服务商名，前缀恰好撞上 Git 工具'],
  ['ConfigChange', 'hooks 事件名（core/hooks.ts），是事件而非工具'],
])

/** 取出源码里所有字符串字面量的内容，跳过注释；模板字面量按整段处理。 */
function stringLiterals(src: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === "'" || c === '"' || c === '`') {
      i++
      let buf = ''
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          buf += src[i + 1] ?? ''
          i += 2
          continue
        }
        buf += src[i]!
        i++
      }
      i++
      out.push(buf)
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
    } else i++
  }
  return out
}

function walkFiles(roots: string[], extensions: string[] = SCANNED_EXTENSIONS): string[] {
  const found: string[] = []
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) visit(p)
      else if (extensions.some((ext) => p.endsWith(ext)) && !/\.test\.|__mocks__/.test(p)) {
        found.push(p)
      }
    }
  }
  for (const root of roots) visit(root)
  return found
}

describe('工具名引用完整性', () => {
  const registered = new Set(createToolRegistry().keys())
  const bases = [...registered].filter((n) => /^[A-Z]/.test(n))

  it('注册表非空，且全部为大写开头（判据本身的前提）', () => {
    expect(registered.size).toBeGreaterThan(0)
    expect(bases.length).toBe(registered.size)
  })

  it('提示词 / 参考表 / locale 文案里不出现「像工具名但不存在的工具名」', () => {
    const hits = new Map<string, { base: string; files: Set<string> }>()

    for (const file of walkFiles(SCAN_ROOTS)) {
      const rel = file.slice(CLI_DIR.length + 1)
      for (const literal of stringLiterals(readFileSync(file, 'utf-8'))) {
        for (const match of literal.matchAll(/\b([A-Z][a-zA-Z0-9]{2,})\b/g)) {
          const token = match[1]!
          if (registered.has(token) || ALLOWED_NON_TOOL_WORDS.has(token)) continue
          for (const base of bases) {
            if (
              token.length > base.length &&
              token.startsWith(base) &&
              /[A-Z]/.test(token[base.length]!)
            ) {
              let hit = hits.get(token)
              if (!hit) hits.set(token, (hit = { base, files: new Set() }))
              hit.files.add(rel)
              break
            }
          }
        }
      }
    }

    const report = [...hits]
      .sort()
      .map(
        ([token, h]) =>
          `  ${token}（前缀 ${h.base}，疑为不存在的工具）← ${[...h.files].sort().join(', ')}`,
      )
      .join('\n')

    expect(
      report,
      hits.size === 0
        ? ''
        : `发现 ${hits.size} 个像工具名但不存在的引用：\n${report}\n\n` +
            '若确为误报，加入 ALLOWED_NON_TOOL_WORDS 并写明理由；若是真实引用，改成注册表中的真实工具名。',
    ).toBe('')
  })
})

describe('工具总数声明完整性', () => {
  const registered = createToolRegistry().size

  /**
   * 工具总数声明，形如 `31 个工具` / `16 tools`。
   *
   * 中文侧要求带「个」是有意的：`（1/34 工具）`（CLAUDE.md 待办一节）说的是
   * Obsidian MCP 服务器自己的第 1/34 个工具，不是本项目的工具总数，不匹配才不误报。
   * 与技能清单守卫同理 —— 守卫的成败取决于不误报。
   *
   * 英文侧必须容忍中间夹着的 `Built-in`：README 惯用「数字 + Built-in Tools」这种写法，
   * 数字与 `tools` 并不相邻，原先的 `(\d+)\+?\s+tools?\b` 因此**根本扫不到它** ——
   * 扫描面里那两行正是靠这个漏洞一直活着（2026-09-15 补，先红后绿）。
   */
  const TOOL_TOTAL_RE = /(\d+)\s*个(?:内置)?工具|(\d+)\s*\+?\s*(?:Built-in\s+)?[Tt]ools?\b/g

  /**
   * 时间点记录 —— 自证定格、或本身就是逐版本流水。里面的旧数字在写下时是对的，
   * 改它等于篡改一份有日期的记录：
   *   - `CHANGELOG.md`：逐版本流水，每条记的是发布当时的事实
   *   - `PRODUCT.md`：抬头写明 `Version 1.0.0 | Date 2026-06-10` 的定格规格书，
   *     通篇是 0.5.x 时代的事实（8 providers / 16 tools / 13 skills / 28+ models）。
   *     它不是「被漏改」，是**不该改** —— 其 §5.1 的 16 正是那张表的真实行数，自洽。
   *     （真问题是 `apps/cli/README.md` 把它当「当前规格」链出去，属另一件事。）
   *
   * 同类另见 `docs/superpowers/**`（设计规格与实施计划）、`docs/claude-md-history.md`、
   * `docs/mipham-code-v0.5.9-wechat-article.md` —— 它们本就不在扫描面内。
   *
   * 但**扫描面必须铺到全部活文档**：只扫「已经修好的那几个」的守卫是空转的，那正是
   * 本文件开头警告的静默恒真。
   *
   * **扫描面按「载体」枚举，不按扩展名**：上面那条 `endsWith('.md')` 只捞得到 Markdown，
   * 于是任何**非 .md 的载体**同样写着工具总数却一路全绿 —— `infrastructure/vscode/package.json`
   * 的 `description`（Marketplace 列表页正文）就这样带着 `30 tools` 活到 2026-09-20。
   * 新增载体时把它加进下面这个数组，**不要**把判据放宽成「扫到就算」。
   */
  const POINT_IN_TIME_ROOT_DOCS = new Set(['CHANGELOG.md', 'PRODUCT.md'])
  const liveDocs = [
    ...readdirSync(REPO_ROOT)
      .filter((f) => f.endsWith('.md') && !POINT_IN_TIME_ROOT_DOCS.has(f))
      .map((f) => join(REPO_ROOT, f)),
    join(CLI_DIR, 'README.md'),
    join(REPO_ROOT, 'infrastructure', 'vscode', 'README.md'),
    // 非 .md 载体：扩展清单。它进 VSIX、直接渲染在 Marketplace 列表页，与 README 同为公开文案。
    join(REPO_ROOT, 'infrastructure', 'vscode', 'package.json'),
  ]

  it('活文档里的工具总数声明与注册表一致', () => {
    const problems: string[] = []
    let claims = 0

    for (const file of liveDocs) {
      const rel = file.slice(REPO_ROOT.length + 1)
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          for (const match of line.matchAll(TOOL_TOTAL_RE)) {
            claims++
            const declared = Number(match[1] ?? match[2])
            if (declared !== registered) {
              problems.push(
                `  ${rel}:${i + 1}: 声明 ${declared} 个工具，注册表实际 ${registered} 个`,
              )
            }
          }
        })
    }

    expect(claims, '没有扫到任何工具总数声明——正则可能已与文档写法脱节').toBeGreaterThan(0)
    expect(
      problems.join('\n'),
      `工具总数声明与注册表不一致：\n${problems.join('\n')}\n\n` +
        `真源是 createToolRegistry()（${registered} 个）。` +
        '若某处并非本项目的工具总数（例如第三方服务器的工具数），改写措辞使其不匹配，不要放宽正则。',
    ).toBe('')
  })
})

describe('技能清单引用完整性', () => {
  // 真实内置技能名 = 磁盘上的技能文件名。bundled-skills.ts 由同一目录生成，
  // 故它不是独立真源，这里不读它。
  const namesIn = (dir: string, suffix: string): string[] =>
    readdirSync(dir)
      .filter((f) => f.endsWith(suffix))
      .map((f) => f.slice(0, -suffix.length))
      .sort()

  const real = {
    Standard: namesIn(join(CLI_DIR, 'skills', 'standard'), '.SKILL.md'),
    Mipham: namesIn(join(CLI_DIR, 'skills', 'mipham'), '.mipham-skill.md'),
  }
  const allReal = new Set([...real.Standard, ...real.Mipham])

  /**
   * 声明式清单，形如 `**Standard (22)**: a, b, c` / `**Mipham Exclusive（6）**: …`。
   * 只扫这种写法，不扫散文——散文里出现的 kebab-case 词大多是普通术语，
   * 按词扫描必然大量误报，而守卫的成败就取决于不误报。
   */
  const INVENTORY_RE =
    /\*\*(Standard|Mipham)(?:\s+Exclusive)?\s*[（(]\s*(\d+)\s*[)）]\s*\*\*\s*[:：]\s*(.+)/g
  /** 总分声明，形如 `ships with 17 built-in skills` / `28 个内置技能`。 */
  const TOTAL_RE = /ships with (\d+) built-in skills|(\d+)\s*个内置技能/g

  const docs = [...walkFiles([join(CLI_DIR, 'skills')], ['.md']), join(REPO_ROOT, 'CLAUDE.md')]

  it('磁盘上确实有技能（判据本身的前提）', () => {
    expect(real.Standard.length).toBeGreaterThan(0)
    expect(real.Mipham.length).toBeGreaterThan(0)
  })

  it('声明式技能清单里的名字都存在，且数量自洽', () => {
    const problems: string[] = []
    let inventories = 0

    for (const file of docs) {
      const rel = file.slice(REPO_ROOT.length + 1)
      const src = readFileSync(file, 'utf-8')

      for (const match of src.matchAll(INVENTORY_RE)) {
        inventories++
        const [, track, countStr, listStr] = match
        const trackName = track as 'Standard' | 'Mipham'
        const declared = Number(countStr)
        const listed = listStr!
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)

        const unknown = listed.filter((n) => !allReal.has(n))
        if (unknown.length > 0) {
          problems.push(`  ${rel}: 不存在的技能名 ${unknown.join(', ')}`)
        }

        const wrongTrack = listed.filter((n) => !real[trackName].includes(n))
        if (wrongTrack.length > 0) {
          problems.push(`  ${rel}: 归入 ${trackName} 轨但不在该轨 ${wrongTrack.join(', ')}`)
        }

        if (declared !== listed.length) {
          problems.push(`  ${rel}: 声明 ${trackName}(${declared}) 但列了 ${listed.length} 个`)
        }
        if (declared !== real[trackName].length) {
          problems.push(
            `  ${rel}: 声明 ${trackName}(${declared})，实际 ${real[trackName].length} 个 —— 磁盘上未列出的：` +
              real[trackName].filter((n) => !listed.includes(n)).join(', '),
          )
        }
      }
    }

    // 写法变了就会静默恒真，所以先确认确实扫到了清单。
    expect(inventories, '没有扫到任何声明式技能清单——正则可能已与文档写法脱节').toBeGreaterThan(0)
    expect(problems.join('\n'), `技能清单与磁盘不一致：\n${problems.join('\n')}`).toBe('')
  })

  it('总分声明与磁盘实际数量一致', () => {
    const problems: string[] = []
    let claims = 0

    for (const file of docs) {
      const rel = file.slice(REPO_ROOT.length + 1)
      for (const match of readFileSync(file, 'utf-8').matchAll(TOTAL_RE)) {
        claims++
        const declared = Number(match[1] ?? match[2])
        if (declared !== allReal.size) {
          problems.push(`  ${rel}: 声明 ${declared} 个内置技能，实际 ${allReal.size} 个`)
        }
      }
    }

    expect(claims, '没有扫到任何总分声明——正则可能已与文档写法脱节').toBeGreaterThan(0)
    expect(problems.join('\n'), `内置技能总数声明与磁盘不一致：\n${problems.join('\n')}`).toBe('')
  })
})

describe('IDE 扩展环境变量契约', () => {
  const EXTENSION = join(REPO_ROOT, 'infrastructure', 'vscode', 'extension.js')

  it('扩展注入 CLI 进程的 MIPHAM_* 环境变量都有 CLI 侧读取点', () => {
    const extSource = readFileSync(EXTENSION, 'utf-8')

    // 注入形式覆盖两种：createTerminal({ env: { ... } }) 与 env.MIPHAM_X = ...
    const injected = new Set<string>()
    for (const match of extSource.matchAll(/env:\s*\{([^}]*)\}/g)) {
      for (const key of match[1]!.matchAll(/\b(MIPHAM_[A-Z0-9_]+)\b/g)) injected.add(key[1]!)
    }
    for (const match of extSource.matchAll(/\benv\.(MIPHAM_[A-Z0-9_]+)\s*=/g)) {
      injected.add(match[1]!)
    }

    const cliSource = walkFiles(SCAN_ROOTS, ['.ts', '.tsx'])
      .map((f) => readFileSync(f, 'utf-8'))
      .join('\n')

    const unread = [...injected].filter(
      (name) =>
        !new RegExp(`process\\.env\\.${name}\\b|process\\.env\\['${name}'\\]`).test(cliSource),
    )

    expect(
      unread.join(', '),
      `扩展注入但 CLI 从不读取：${unread.join(', ')} —— 删掉注入，或补上消费者`,
    ).toBe('')
    // 注：当前扩展不注入任何 MIPHAM_* 变量，故本条目前恒真。
    // 它是绊线——新增注入而没有消费者时会立刻变红，正是 MIPHAM_IDE 当初的形态。
  })
})

/**
 * 变更记录表的**去向**与文档体积。
 *
 * 守的是一类与「引用了不存在的东西」不同的缺陷：**没有上限的累积**。
 * CLAUDE.md 的 `## 最近提交` 曾是 5 行滚动窗口（2026-09-18 收窄至 3），但这条约定在拆分之前的全仓库
 * 文档里一字未写（grep `5 行` / `滚动` / `上限` 零命中），于是 `### 修订历史`
 * 无人看管地长到 8 行 / 26,229 字符 = 全文 60%，拆分 17 小时后整份文件从
 * 21,193 长回 56,001 字符（+164%），二次越过当初触发拆分的 40k 红线。
 * 成文 + 守卫 + 把旧条目搬进 `docs/claude-md-history.md`，三者缺一不可。
 *
 * **2026-09-19（2.66.0）契约换向：两张表整体移出，正文只留指针。** 收紧窗口治不了本 ——
 * 窗口只约束**行数**，而 prettier 把列宽设成**最宽那一行**、全表按它补齐 ⇒ 新增一行的边际
 * 成本 ≈ 最宽行宽 × 行数；只要表还住在文件里，每次改动就必然增长（实测「挤掉最宽行换更窄的」
 * 这一手最多净省 2,102 字符，而移出的是 8,230 = 全文 21.9%）。代价是**存档与指针从此都是
 * 承重的**，故断言换向：两段**零数据行** + 各段正文**含指向存档的链接** + **存档在位、两张
 * 全表都还在**。最后一条补的是一个真实的洞 —— 此前全仓库无任何测试读 `docs/claude-md-history.md`
 * （`ARCHIVE` 当时只是报错文案里的一个字符串），删掉它是一条全绿的路径。
 *
 * 刻意**不用** `prompt-exclude` / 按标题剥整段的办法来「减重」：按标题剥会把
 * `> 完整记录 → docs/claude-md-history.md` 那行指针一起剥掉，读者反而失去去路
 * （拆分提交 a278151 已记录此教训）。指针现在是那两段**唯一**的内容，更剥不得。
 */
describe('变更记录表的去向与文档体积', () => {
  const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md')
  /** CLAUDE.md 全文字符预算——当初触发拆分的那条红线。 */
  const MAX_CHARS = 40_000
  /** 两张表的搬运目的地：正文指针必须指向它，它本身也必须真的还在。 */
  const ARCHIVE = 'docs/claude-md-history.md'
  const ARCHIVE_PATH = join(REPO_ROOT, ARCHIVE)
  /**
   * 两段的**段名**。
   *
   * 按名字定位、不按 `#` 层级 —— CLAUDE.md 里是 `### 修订历史`、存档里是 `## 修订历史`，
   * 层级是排版细节，名字才是锚。
   */
  const SECTIONS = ['最近提交', '修订历史']

  const HEADING_RE = /^#{2,}\s/

  /** 该行是不是标题「name」（`##` 及以上层级）。 */
  function isHeading(line: string, name: string): boolean {
    return HEADING_RE.test(line) && line.replace(/^#+\s+/, '').trim() === name
  }

  /**
   * 取「name」那一段的行（标题之后 → 下一个标题 / `---` / 文末）；**标题不存在时返回 `null`**。
   *
   * `null` 与空数组必须分开：重命名标题与「段内确实没有内容」是两件事，混成一个就会让
   * 「标题被改名」读成「表已经没有了」而**静默恒真** —— 那正是本文件一开始要防的那种假绿。
   */
  function section(src: string, name: string): string[] | null {
    const lines = src.split('\n')
    const start = lines.findIndex((l) => isHeading(l, name))
    if (start === -1) return null

    const out: string[] = []
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!
      // 下一个标题（任意层级）或分隔线即段末。
      if (HEADING_RE.test(line) || line.startsWith('---')) break
      out.push(line)
    }
    return out
  }

  /**
   * 从一段正文里取第一张表的数据行。
   *
   * 用**结构**判定而非列名：markdown 表必定是 `表头 | 分隔行 | 数据…`，故分隔行
   * 之前的一律不算数据。这样列名一改、列序一调，判定都不会跟着错——按列名匹配
   * 正是那种「文档写法一变守卫就静默恒真」的写法。
   */
  function tableRows(lines: string[]): string[] {
    const rows: string[] = []
    let inTable = false
    for (const line of lines) {
      if (!line.startsWith('|')) {
        if (inTable) break // 表格结束
        continue
      }
      if (/^\|[\s|:-]+\|$/.test(line)) {
        inTable = true // 分隔行：其后才是数据行
        continue
      }
      if (inTable) rows.push(line)
    }
    return rows
  }

  it('两段标题都还在，且正文各留指向存档的指针', () => {
    const src = readFileSync(CLAUDE_MD, 'utf-8')

    for (const name of SECTIONS) {
      const body = section(src, name)
      // 标题一改名，下面每条断言都会静默恒真，所以先确认标题还在。
      expect(body, `CLAUDE.md 里没有标题「${name}」——这段去哪了？`).not.toBeNull()
      expect(
        body?.join('\n'),
        `「${name}」段正文没有指向 ${ARCHIVE} 的链接——表移出后，指针是唯一的去路`,
      ).toContain(`](${ARCHIVE})`)
    }
  })

  it('两张变更记录表都已移出 CLAUDE.md——段内不得再有数据行', () => {
    const src = readFileSync(CLAUDE_MD, 'utf-8')

    for (const name of SECTIONS) {
      const body = section(src, name)
      expect(body, `CLAUDE.md 里没有标题「${name}」`).not.toBeNull()

      const rows = tableRows(body!)
      expect(
        rows.length,
        `「${name}」段里还有 ${rows.length} 行表数据——表住在 CLAUDE.md 里就必然随每次改动增长` +
          `（prettier 按最宽行补齐，一行代价 ≈ 最宽行宽 × 行数）；全表在 ${ARCHIVE}`,
      ).toBe(0)
    }
  })

  it('存档文件在位，且两张全表都还在里面', () => {
    expect(
      existsSync(ARCHIVE_PATH),
      `${ARCHIVE} 不存在——表移出 CLAUDE.md 之后，它是唯一的全量记录`,
    ).toBe(true)

    const src = readFileSync(ARCHIVE_PATH, 'utf-8')
    for (const name of SECTIONS) {
      const body = section(src, name)
      expect(body, `${ARCHIVE} 里没有标题「${name}」`).not.toBeNull()

      const rows = tableRows(body!)
      expect(
        rows.length,
        `${ARCHIVE} 的「${name}」表只剩 ${rows.length} 行——CLAUDE.md 已不再保留任何条目，` +
          `被挤出的行全落在这里，删空即内容不可恢复`,
      ).toBeGreaterThan(0)
    }
  })

  it('CLAUDE.md 保持在体积预算内', () => {
    const chars = readFileSync(CLAUDE_MD, 'utf-8').length
    expect(
      chars,
      `CLAUDE.md 已 ${chars} 字符，预算 ${MAX_CHARS}——` +
        `新增解释性内容写进表外散文（表内一格会让全表各行补一次 pad）`,
    ).toBeLessThanOrEqual(MAX_CHARS)
  })
})
