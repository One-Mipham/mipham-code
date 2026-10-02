/**
 * `prompt-exclude` 完整性守卫 —— 条目名写错一个字，「排除」**静默失效**。
 *
 * `stripSections` 按标题**逐字相等**匹配（`excluded.includes(title)`）。匹配不上时它
 * 不抛错、不告警：那一节照旧随每一次请求发出去，而写排除的人以为省下了——省下的
 * 是 0 个字符。启动告警也帮不上忙，因为那一节的字数本来就还在总额里，告警**看起来
 * 完全正常**。于是「拼错」与「有意不排除」在屏幕上同形。
 *
 * 判据**派生自实现**：`stripSections(body, [entry]) !== body` 当且仅当该条目真的匹配到
 * 了一个标题——匹配上就必然删掉那一行标题本身，二者不可能相等。用同一把尺子量，
 * 规则若改（比如以后支持层级通配、支持锚点），守卫跟着一起改，不会出现「守卫按旧
 * 规则绿、实现按新规则一个都没删」。
 *
 * 覆盖面是本次装载**实际进来的**每一份指令文件：除本仓那几份外，还包括若干份位于
 * 仓库之外的祖先层文件（父仓 `One_Mipham_Corporation/CLAUDE.md`、集团层 `CLAUDE.md` 等）。
 * ⚠️ **诚实边界**：那条覆盖只在本地成立——CI 的检出目录之上没有这些祖先层，于是
 * 门外那份的错字 CI 抓不到，只有在本机跑测试或开一个会话才会现形。用户层
 * （`~/.mipham/USER.md`）刻意不查：拿别人机器上的错字把本仓判红是误报。
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { homedir } from 'node:os'

import {
  InstructionsLoader,
  gitRoot,
  parseFrontmatter,
  parsePromptExclude,
  stripSections,
} from '../../src/core/instructions'
import { miphamHome } from '../../src/core/paths'

/** 向上走到仓库根（以 `pnpm-workspace.yaml` 为锚）—— 与 `tool-reference-integrity` 同法。 */
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

/** 用户层目录：不由本仓提交改变，故不进判据。 */
const USER_TIER_DIRS = [join(homedir(), '.claude'), miphamHome()]

/** 一份指令文档里**匹配不到任何标题**的 `prompt-exclude` 条目——静默失效的那些。 */
function deadExcludes(content: string): string[] {
  const { data, content: body } = parseFrontmatter(content)
  return parsePromptExclude(data['prompt-exclude']).filter(
    (entry) => stripSections(body, [entry]) === body,
  )
}

describe('prompt-exclude 的每个条目都必须真的匹配到某一节', () => {
  it('认得出拼错的条目——探针本身要能失败', () => {
    const doc = (entry: string) =>
      `---\nprompt-exclude:\n  - ${entry}\n---\n\n## 技术栈标准\n\n正文\n`

    // 负控：`技术栈` 少两个字，`技术栈标准` 那一节不会被删 —— 若这条守卫恒返回空数组，
    // 下面那条「全绿」就只是在说「探针没在跑」。
    expect(deadExcludes(doc('技术栈'))).toEqual(['技术栈'])
    // 正控：逐字相等时不许报警，否则守卫会逼人删掉正确的排除。
    expect(deadExcludes(doc('技术栈标准'))).toEqual([])
    // 没有 frontmatter / 没有该键：无事发生。
    expect(deadExcludes('## 技术栈标准\n\n正文\n')).toEqual([])
  })

  it('本次装载的指令文件里没有失效的排除条目', () => {
    const loader = new InstructionsLoader()
    loader.loadAll(REPO_ROOT)
    const files = loader
      .sizeReport()
      .files.map((f) => f.path)
      .filter((p) => !USER_TIER_DIRS.some((d) => p === d || p.startsWith(d + sep)))

    const root = gitRoot(REPO_ROOT)
    expect(
      files.filter((p) => p.startsWith(root + sep)).length,
      `git 根 ${root} 下一份指令文件都没被读进来——判据退化成空和`,
    ).toBeGreaterThan(0)

    const contents = files.map((p) => [p, readFileSync(p, 'utf-8')] as const)
    const declaring = contents.filter(([, c]) => {
      const { data } = parseFrontmatter(c)
      return parsePromptExclude(data['prompt-exclude']).length > 0
    })
    expect(
      declaring.length,
      `本次装载的 ${files.length} 份指令文件里没有一份带 prompt-exclude——` +
        '「一条都没失效」这时只是在说没测到东西',
    ).toBeGreaterThan(0)

    const dead = contents.flatMap(([path, content]) =>
      deadExcludes(content).map((entry) => `  ${entry}\n    ↳ ${path}`),
    )
    expect(
      dead,
      `这些 prompt-exclude 条目匹配不到任何标题，排除静默失效（那一节仍在每次请求里发出）：\n` +
        `${dead.join('\n')}\n` +
        '多半是标题被改名或条目名打错——按标题**逐字**（含全角括号）对齐。',
    ).toEqual([])
  })
})
