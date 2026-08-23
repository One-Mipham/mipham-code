/**
 * CLAUDE.md audit — find sections whose content the model can infer from the
 * codebase itself (directory structure, tech stack, dependencies, commit
 * history, project/submodule catalogs, test counts). Such sections burn
 * context tokens every session and go stale as the code changes; they are
 * candidates for the `prompt-exclude` frontmatter.
 */

export type DerivableReason =
  'structure' | 'tech-stack' | 'dependencies' | 'commits' | 'catalog' | 'tests'

export interface DerivableSection {
  heading: string
  reason: DerivableReason
}

/** Human-readable hint for each derivable category (diagnostic output). */
export const DERIVABLE_HINTS: Record<DerivableReason, string> = {
  structure: 'directory/file structure — inferable from the repo itself',
  'tech-stack': 'tech stack — inferable from package.json / config',
  dependencies: 'dependencies — inferable from package.json',
  commits: 'commit/revision history — inferable from git log',
  catalog: 'project/submodule catalog — inferable from .gitmodules / directories',
  tests: 'test counts — inferable from running the suite',
}

const PATTERNS: Array<{ pattern: RegExp; reason: DerivableReason }> = [
  {
    pattern:
      /目录结构|项目结构|文件结构|directory structure|project structure|file structure|repo structure|monorepo/i,
    reason: 'structure',
  },
  { pattern: /技术栈|tech\s*stack|technology\s*stack/i, reason: 'tech-stack' },
  { pattern: /依赖关系|依赖清单|dependencies/i, reason: 'dependencies' },
  {
    pattern: /最近提交|recent\s*commit|修订历史|revision\s*history|changelog|变更记录|变更历史/i,
    reason: 'commits',
  },
  {
    pattern: /项目一览|项目清单|项目列表|子模块清单|submodule\s*(list|catalog)|catalog/i,
    reason: 'catalog',
  },
  { pattern: /测试矩阵|test\s*matrix|测试覆盖|coverage/i, reason: 'tests' },
]

/**
 * Return `##`/`###` headings whose title matches a derivable-content pattern,
 * in document order. Headings without a match are ignored.
 */
export function findDerivableSections(content: string): DerivableSection[] {
  const found: DerivableSection[] = []
  for (const line of content.split('\n')) {
    const m = line.match(/^(#{2,3})\s+(.+?)\s*$/)
    if (!m) continue
    const heading = m[2]!.trim()
    for (const { pattern, reason } of PATTERNS) {
      if (pattern.test(heading)) {
        found.push({ heading, reason })
        break
      }
    }
  }
  return found
}
