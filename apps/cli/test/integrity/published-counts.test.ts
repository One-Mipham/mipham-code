import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DEFAULT_PROVIDERS } from '../../src/shared/constants'
import { createToolRegistry } from '../../src/tools/index'
import { getCommandNames } from '../../src/ui/commands'

/**
 * 公开面计数的真源守卫（D16，2026-09-25）。
 *
 * 立这道守卫的起因：两个官网的产品页把「137 命令 · 3473 测试」当**字面量**写死。
 * 三套既有守卫（工具名 / 工具总数 / 提供商与模型总数）都够不着它们 —— 不是因为
 * 规则写松了，而是因为它们的**载体在另一个仓库**（`websites`），而守卫按设计只扫
 * 本仓库的文件。修法不是把守卫伸过去（跨仓库的文本扫描极脆），而是让那两页
 * **一个数字都不持有**，改读 `package-info.json` 里新增的四个槽位；本文件守的
 * 就是「那四个槽位与真源一致」。
 *
 * `package-info.json` 早就在两站的 deploy 脚本里被 `cp` 覆盖过去（传播链一直存在），
 * 缺的只是槽位 —— 名字和版本有槽位，所以它们不漂；计数连槽位都没有。
 *
 * 本文件自足（自带 `findRepoRoot`），与 `tool-reference-integrity.test.ts` 同一约定：
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

/** 落盘的三份副本。**按字节读**，不 import —— 守卫要检的是**发出去的那份文件**。 */
const STORED_FILES = [
  join(REPO_ROOT, 'packages/shared/package-info.json'),
  join(REPO_ROOT, 'packages/shared/src/package-info.ts'),
  join(CLI_DIR, 'src/shared/package-info.ts'),
]

/**
 * 从落盘文件里取一个计数常量。
 *
 * **取不到就抛**，不返回 undefined —— 否则正则与文件写法脱节时，下面的比对会
 * 变成「两边都读不到 ⇒ 不相等」还是「都没扫到 ⇒ 全绿」，取决于写法，而后者是
 * 静默恒真。宁可炸。
 */
function storedValue(file: string, key: string): number {
  const src = readFileSync(file, 'utf-8')
  const m = src.match(new RegExp(`"?${key}"?\\s*[:=]\\s*(\\d+)`))
  if (!m) throw new Error(`${file} 里找不到 ${key} 的声明 —— 落盘格式可能已改`)
  return Number(m[1])
}

describe('公开面计数：落盘值 = 进程内真源', () => {
  // 真源全部在进程内，无一需要联网或跑套件。
  const trueSources: Record<string, number> = {
    SLASH_COMMAND_COUNT: getCommandNames().length,
    PROVIDER_COUNT: DEFAULT_PROVIDERS.length,
    TOOL_COUNT: createToolRegistry().size,
  }

  it('真源本身非空（判据的前提）', () => {
    // 没有这一条，下面「三份副本都对上」可能只是因为真源是 0、而副本也恰好被写成 0。
    for (const [key, value] of Object.entries(trueSources)) {
      expect(value, `真源 ${key} 是 0 —— 说明取值路径断了，不是计数真的为 0`).toBeGreaterThan(0)
    }
  })

  it('三份落盘副本的四个计数与真源逐一对齐', () => {
    const problems: string[] = []
    let comparisons = 0

    for (const file of STORED_FILES) {
      const rel = file.slice(REPO_ROOT.length + 1)
      for (const [key, expected] of Object.entries(trueSources)) {
        comparisons++
        const actual = storedValue(file, key)
        if (actual !== expected) problems.push(`  ${rel}: ${key} = ${actual}，真源 = ${expected}`)
      }
    }

    // 正对照：3 份 × 3 个数 = 9 次比对。少一次都说明读取路径悄悄退化了。
    expect(comparisons, '比对次数不足 —— 有文件或字段被静默跳过').toBe(9)
    expect(
      problems.join('\n'),
      `公开面计数与真源不一致：\n${problems.join('\n')}\n\n` +
        `真源：getCommandNames() / DEFAULT_PROVIDERS / createToolRegistry()。\n` +
        `**不要手改** —— 跑 \`cd apps/cli && bun run scripts/sync-counts.ts\` 重新产出。`,
    ).toBe('')
  })
})

/**
 * 测试总数的**一致性**检查（不是真值检查）。
 *
 * 真值只能由**跑一次真套件**得到，本文件做不到；那半由 CI 的 Test job 守
 * （`sync-counts.ts --check --test-report <json>`，套件自报总数 ≠ 落盘值即红）。
 * 这里守的是另一半：**CLAUDE.md 里那几个数必须与落盘值字面一致** —— 也就是把
 * 过去靠「记得五处一起改」的手工纪律，换成机器比对。
 *
 * **为什么只认这三种写法**：CLAUDE.md 里还有 `179 个测试`（telemetry 包，另一个
 * 计数）与 `12 个测试文件`，宽泛的 `(\d+) 个测试` 会一头撞上它们。故：
 *   1. `测试：N 测试（…）` —— 头部的规范声明，只有一处；
 *   2. `(\d{4,}) 个测试` —— 用**四位数下限**把 telemetry 的 179 排除在外。这是
 *      量级差不是原理：哪天 telemetry 上千，这里会**开始误报**（而不是漏报）——
 *      误报是安全方向，届时按「改写措辞或另立载体」处理，**不要放宽正则**；
 *   3. `| **合计** | **文件数** | **N** |` —— 测试表末行。
 *
 * **已知边界（如实写在这里，不假装覆盖）**：CLAUDE.md 的 test 表里**逐行**的文件数
 * 与测试数（core / tools / daemon …）不在守卫内 —— 它们与总数是两套数，且每次
 * 增删测试都要重排整表，机器比对会变成噪声源。
 */
describe('测试总数：活文档与落盘值一致', () => {
  const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md')
  const HEAD_RE = /测试：(\d[\d,]*) 测试（/g
  const TREE_RE = /(\d{4,}) 个测试/g
  const TABLE_RE = /\|\s*\*\*合计\*\*\s*\|\s*\*\*\d+\*\*\s*\|\s*\*\*(\d+)\*\*/g

  it('CLAUDE.md 的三种写法都与 TEST_COUNT 一致', () => {
    const expected = storedValue(STORED_FILES[2]!, 'TEST_COUNT')
    const lines = readFileSync(CLAUDE_MD, 'utf-8').split('\n')
    const problems: string[] = []
    const hits: Record<string, number> = { head: 0, tree: 0, table: 0 }

    lines.forEach((line, i) => {
      const check = (re: RegExp, kind: keyof typeof hits) => {
        for (const m of line.matchAll(re)) {
          hits[kind]!++
          const declared = Number(m[1]!.replace(/,/g, ''))
          if (declared !== expected) {
            problems.push(`  CLAUDE.md:${i + 1}: 声明 ${declared}，落盘值 ${expected}`)
          }
        }
      }
      check(HEAD_RE, 'head')
      check(TREE_RE, 'tree')
      check(TABLE_RE, 'table')
    })

    // 三种写法**各自**都要至少命中一次 —— 否则是正则与文档脱节（静默恒真），
    // 而不是「文档里恰好没有」。
    expect(hits.head, '`测试：N 测试（…）` 一处都没扫到 —— 正则可能已与文档脱节').toBeGreaterThan(0)
    expect(hits.tree, '`N 个测试` 一处都没扫到 —— 正则可能已与文档脱节').toBeGreaterThan(0)
    expect(hits.table, '测试表末行一处都没扫到 —— 正则可能已与文档脱节').toBeGreaterThan(0)

    expect(
      problems.join('\n'),
      `CLAUDE.md 的测试总数与落盘值不一致：\n${problems.join('\n')}\n\n` +
        `落盘值 = ${expected}（package-info）。改测试数的提交必须**同一提交内**回填这些数，` +
        `并跑 \`bun run scripts/sync-counts.ts --test-report <vitest.json>\` 重写落盘值。`,
    ).toBe('')
  })
})

/**
 * 命令总数声明完整性 —— D15 明确的守卫缺口：那对 i18n 副本
 * （`packages/shared/src/i18n/locales/*` ↔ `apps/cli/src/i18n-core/locales/*`）
 * **不在** `shared-vendor-parity.test.ts` 的族表里，而 `packages/shared/**`
 * 也不在 `tool-reference-integrity.test.ts` 的 `SCAN_ROOTS` 里 ⇒ 两套守卫都够不着。
 * 那 4 个文件里曾同时写着 `85`（真值 137），两边一路全绿。
 *
 * **为什么不能只靠「两份副本值相等」**：当时两份写的是**同一个错值**，值相等的
 * 守卫只会全绿 —— 它证的是两份一致，不是两份对。要抓它得另有真值判据，就是这里。
 */
describe('命令总数声明完整性', () => {
  const COMMAND_COUNT = getCommandNames().length

  const POINT_IN_TIME_ROOT_DOCS = new Set(['CHANGELOG.md', 'PRODUCT.md'])
  const liveDocs = [
    ...readdirSync(REPO_ROOT)
      .filter((f) => f.endsWith('.md') && !POINT_IN_TIME_ROOT_DOCS.has(f))
      .map((f) => join(REPO_ROOT, f)),
    join(CLI_DIR, 'README.md'),
    join(REPO_ROOT, 'infrastructure', 'vscode', 'README.md'),
    join(REPO_ROOT, 'infrastructure', 'vscode', 'package.json'),
  ]

  /**
   * 逐个豁免并写明理由（不是放宽规则，更不是删掉守卫）。
   *
   * ROADMAP.md：里面**合法地**写着两处「85 Slash Commands」—— 那是在**引述**当初
   * 那两份副本错成了什么，是历史陈述而不是声明。把它扫进来这两行会红，而它们是对的。
   * 豁免范围是**这一个数**：工具 / 提供商 / 模型总数的守卫照旧扫 ROADMAP。
   */
  const EXEMPT = new Map<string, string>([
    [join(REPO_ROOT, 'ROADMAP.md'), '两处合法引述历史错值「85 Slash Commands」，是陈述不是声明'],
  ])

  /** 那对 i18n 副本的 4 个文件 —— 上面那段注释里的守卫缺口，本段把它补上。 */
  const I18N_CARRIERS = [
    join(REPO_ROOT, 'packages/shared/src/i18n/locales/en-US.json'),
    join(REPO_ROOT, 'packages/shared/src/i18n/locales/zh-CN.json'),
    join(CLI_DIR, 'src/i18n-core/locales/en-US.json'),
    join(CLI_DIR, 'src/i18n-core/locales/zh-CN.json'),
  ]

  const carriers = [...liveDocs.filter((f) => !EXEMPT.has(f)), ...I18N_CARRIERS]

  /**
   * 四种写法，全部由**实测的载体内容**反推（不是照想象写的）：
   *   `137 commands` / `137 Slash Commands` / `137 个 Slash 命令` / `137 个命令`
   *   / `Show all available commands (137)` / `Slash 命令系统（137 个）`
   *
   * 中文侧要求带「个」、英文侧要求 `commands` 与数字相邻，都是为**不误报**：
   * 放开成 `(\d+)` 会去匹配 `exit code 137`（`tools/exec/bash.ts`）、
   * `（1/34 工具）` 那类第三方计数、以及 `137 killed`（变异测试读数）。
   * 与工具总数守卫同一取舍：守卫的成败取决于不误报。
   *
   * `── All Slash Commands ({count}) ──` 这类**模板**刻意不匹配
   * （`{count}` 不是数字）—— 它本来就是动态的，是正确写法。
   */
  const COMMAND_TOTAL_RES = [
    /(\d+)\s+(?:Slash\s+)?[Cc]ommands?\b/g,
    /[Cc]ommands?\s*[（(]\s*(\d+)/g,
    /(\d+)\s*个\s*(?:Slash\s*)?命令/g,
    /命令[^（(\n]{0,6}[（(]\s*(\d+)\s*个/g,
  ]

  it('活文档与 i18n 副本里的命令总数声明与注册表一致', () => {
    const problems: string[] = []
    let claims = 0

    for (const file of carriers) {
      const rel = file.slice(REPO_ROOT.length + 1)
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, i) => {
          for (const re of COMMAND_TOTAL_RES) {
            for (const match of line.matchAll(re)) {
              claims++
              const declared = Number(match[1])
              if (declared !== COMMAND_COUNT) {
                problems.push(
                  `  ${rel}:${i + 1}: 声明 ${declared} 条命令，注册表实际 ${COMMAND_COUNT} 条`,
                )
              }
            }
          }
        })
    }

    expect(claims, '没有扫到任何命令总数声明 —— 正则可能已与文档写法脱节').toBeGreaterThan(0)
    expect(
      problems.join('\n'),
      `命令总数声明与注册表不一致：\n${problems.join('\n')}\n\n` +
        `真源是 getCommandNames()（src/ui/commands.ts）—— ${COMMAND_COUNT} 条。\n` +
        `**不要手改数字**：i18n 那两份副本的 \`web.features.slash_commands\` 要两份一起改；` +
        `官网页面从 package-info.json 读 SLASH_COMMAND_COUNT，不持有字面量。`,
    ).toBe('')
  })
})
