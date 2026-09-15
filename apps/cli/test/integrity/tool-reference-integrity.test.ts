/**
 * 引用完整性守卫 —— 抓住「引用了不存在的东西，且没有守卫能抓」这一类缺陷。
 *
 * 本仓库已发生四次同类事故，共同点都是**引用方与被引用方分处不同文件**，
 * 于是类型检查与既有测试都看不见：
 *   1. `core/rules-loader.ts` 只定义不接线（`setRulesLoader` 全仓库零调用点）
 *   2. 内置 `superpower` skill 残留上游技能名（`brainstorming` / `mcp-builder` 等）
 *   3. VS Code 扩展注入 `MIPHAM_IDE` 环境变量，CLI 侧零消费者
 *   4. `/todos` 的提示词、参考表与 locale 文案引用 `TaskCreate` / `TaskList` 等
 *      不存在的工具名（真实工具只有一个 `Task`，动作走 `action` 参数）
 *
 * 本文件用四段机器可校验的契约覆盖上述缺陷类。守卫的价值取决于**不误报**——
 * 实测（2026-09-15）扫描命中 6 个幻影名（分布在 10 处），误报 0；被排除的合法词
 * `GitHub` / `GitLab` / `ConfigChange` 见 ALLOWED_NON_TOOL_WORDS。误报的处理方式是
 * **加白名单并写明理由**，不是放宽规则、更不是删掉守卫。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { createToolRegistry } from '../../src/tools/index'

const CLI_DIR = join(import.meta.dirname, '..', '..')
const REPO_ROOT = join(CLI_DIR, '..', '..')

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
   */
  const TOOL_TOTAL_RE = /(\d+)\s*个(?:内置)?工具|(\d+)\+?\s+tools?\b/g

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
   */
  const POINT_IN_TIME_ROOT_DOCS = new Set(['CHANGELOG.md', 'PRODUCT.md'])
  const liveDocs = [
    ...readdirSync(REPO_ROOT)
      .filter((f) => f.endsWith('.md') && !POINT_IN_TIME_ROOT_DOCS.has(f))
      .map((f) => join(REPO_ROOT, f)),
    join(CLI_DIR, 'README.md'),
    join(REPO_ROOT, 'infrastructure', 'vscode', 'README.md'),
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
