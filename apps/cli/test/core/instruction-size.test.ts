import { describe, it, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { execSync } from 'node:child_process'
import {
  InstructionsLoader,
  formatInstructionSizeNotice,
  INSTRUCTION_BUDGET_CHARS,
} from '../../src/core/instructions'
import { LESSONS_FILE } from '../../src/core/crsi-producer'

/**
 * The startup notice about how much instruction text a session carries.
 *
 * No single file has to be large for the payload to crowd out the work: the
 * group / company / project tiers, a directory of rule files and the CRSI
 * lessons block add up. So the number that matters is the **total** — and it has
 * to be measured on the text that is actually sent. This repository hides tens
 * of thousands of characters behind `prompt-exclude`, so a report that measured
 * the files on disk would warn about a payload nobody is paying for.
 */

/** A git repo in a temp dir, so the loader's tier discovery is deterministic. */
function repoFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-instr-size-')))
  execSync('git init -q', { cwd: root })
  return root
}

const RULE_LINE = '- a rule that has to be read and applied on every single request\n'

/** A rules file of at least `chars` characters. */
function rulesOfSize(chars: number): string {
  return `# Rules\n\n${RULE_LINE.repeat(Math.ceil(chars / RULE_LINE.length))}`
}

function sizeOfFile(loader: InstructionsLoader, path: string): number | undefined {
  return loader.sizeReport().files.find((f) => f.path === path)?.chars
}

describe('InstructionsLoader.sizeReport', () => {
  it('reports many mid-sized files together, none of them large on its own', () => {
    const root = repoFixture()
    try {
      const names = ['AGENTS.md', 'MIPHAM.md', 'CLAUDE.md']
      for (const name of names) writeFileSync(join(root, name), rulesOfSize(15_000))

      const loader = new InstructionsLoader()
      loader.loadAll(root)
      const report = loader.sizeReport()

      // Only the files this test wrote — the user tier may load from the real home.
      const mine = report.files.filter((f) => f.path.startsWith(root + '/'))
      expect(mine.map((f) => f.path.slice(root.length + 1)).sort()).toEqual([...names].sort())
      for (const f of mine) expect(f.chars).toBeLessThan(INSTRUCTION_BUDGET_CHARS)

      // Individually under budget, together over it — which is the case a
      // per-file check cannot see.
      const together = mine.reduce((n, f) => n + f.chars, 0)
      expect(together).toBeGreaterThan(INSTRUCTION_BUDGET_CHARS)
      expect(report.totalChars).toBeGreaterThanOrEqual(together)
      expect(report.files[0]!.chars).toBeGreaterThanOrEqual(report.files.at(-1)!.chars)
      expect(formatInstructionSizeNotice(report)).toContain('Instruction files total')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves a private file out of the count as well as the prompt', () => {
    const root = repoFixture()
    try {
      const path = join(root, 'CLAUDE.md')
      writeFileSync(path, '---\nprivacy: private\n---\n# Secret\n- do not send me\n')

      const loader = new InstructionsLoader()
      loader.loadAll(root)

      expect(sizeOfFile(loader, path)).toBeUndefined()
      expect(loader.buildSystemPrompt()).not.toContain('do not send me')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not count a doc-only section that prompt-exclude keeps out of the prompt', () => {
    // Same rules in both files; the second one carries ~34 KB of never-sent docs.
    // The leading blank line matters: a section stripped straight after the body
    // takes the newline that separated them with it, and the two fixtures would
    // then differ by one character for a reason that has nothing to do with counting.
    const body = rulesOfSize(4_000)
    const deadSection = `\n## 修订历史\n\n${'| old | row |\n'.repeat(3_000)}`
    const sizes: number[] = []

    for (const content of [body, `${body}${deadSection}`]) {
      const root = repoFixture()
      try {
        const path = join(root, 'CLAUDE.md')
        writeFileSync(path, `---\nprompt-exclude:\n  - 修订历史\n---\n${content}`)
        const loader = new InstructionsLoader()
        loader.loadAll(root)

        const prompt = loader.buildSystemPrompt()
        expect(prompt).toContain(RULE_LINE.split('\n')[0])
        expect(prompt).not.toContain('| old | row |')

        const chars = sizeOfFile(loader, path)!
        expect(chars).toBeGreaterThan(4_000) // the entry is there, and is real
        sizes.push(chars)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }

    expect(sizes[0]).toBe(sizes[1])
  })

  it('counts the CRSI lessons block, which is instruction text from a file too', () => {
    const root = repoFixture()
    try {
      const path = join(root, LESSONS_FILE)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '## A hard-won lesson\n\n- 证据: it happened\n- 建议: do the thing\n')

      const loader = new InstructionsLoader()
      loader.loadAll(root)

      expect(sizeOfFile(loader, path)).toBeGreaterThan(0)
      expect(loader.buildSystemPrompt()).toContain('do the thing')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('formatInstructionSizeNotice', () => {
  function report(sizes: number[]) {
    const files = sizes
      .map((chars, i) => ({ path: `/repo/file-${i}.md`, chars }))
      .sort((a, b) => b.chars - a.chars)
    return { totalChars: sizes.reduce((n, s) => n + s, 0), files }
  }

  it('stays silent while the total is within budget', () => {
    expect(formatInstructionSizeNotice(report([20_000, 19_000]))).toBeNull()
    // The boundary is inclusive: at the budget there is nothing to say.
    expect(formatInstructionSizeNotice(report([INSTRUCTION_BUDGET_CHARS]))).toBeNull()
    expect(formatInstructionSizeNotice(report([INSTRUCTION_BUDGET_CHARS + 1]))).not.toBeNull()
  })

  it('names the total and the biggest contributors, largest first', () => {
    const notice = formatInstructionSizeNotice(report([30_000, 25_000, 5_000]))
    expect(notice).toContain('60,000')
    expect(notice).toContain('file-0.md')
    expect(notice!.indexOf('file-0.md')).toBeLessThan(notice!.indexOf('file-1.md'))
    // The actionable lever, named rather than implied.
    expect(notice).toContain('prompt-exclude')
  })

  it('summarizes the tail instead of listing every file', () => {
    const notice = formatInstructionSizeNotice(report([20_000, 20_000, 20_000, 20_000, 20_000]))
    expect(notice).toContain('file-0.md')
    expect(notice).not.toContain('file-4.md')
    expect(notice).toContain('+2 more')
  })
})
