import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RulesLoader } from '../../src/core/rules-loader'

// ── Helpers ──

let root: string
let rulesDir: string

function writeRule(name: string, body: string): void {
  writeFileSync(join(rulesDir, name), body)
}

beforeEach(() => {
  // realpathSync: macOS tmpdir is /var → /private/var; keep the path we assert on stable.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-rules-')))
  rulesDir = join(root, '.mipham', 'rules')
  mkdirSync(rulesDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ── Tests ──

describe('RulesLoader — loading', () => {
  it('loads markdown rule files from .mipham/rules/', () => {
    writeRule(
      'typescript.md',
      '---\npaths: "*.ts"\ndescription: TS standards\n---\nUse strict mode.\n',
    )
    writeRule('always.md', 'Applies everywhere.\n')

    const loader = new RulesLoader(root)
    loader.load()

    expect(loader.count()).toBe(2)
    expect(loader.list().sort()).toEqual(['always', 'typescript'])
  })

  it('ignores non-markdown files', () => {
    writeRule('notes.txt', 'not a rule')
    writeRule('real.md', 'body')

    const loader = new RulesLoader(root)
    loader.load()

    expect(loader.list()).toEqual(['real'])
  })

  it('is a no-op when .mipham/rules/ does not exist', () => {
    const loader = new RulesLoader(join(root, 'no-such-workspace'))
    loader.load()

    expect(loader.count()).toBe(0)
    expect(loader.buildContextBlock(['src/a.ts'])).toBe('')
  })

  it('re-loading replaces rather than accumulates', () => {
    writeRule('a.md', 'first')
    const loader = new RulesLoader(root)
    loader.load()
    expect(loader.count()).toBe(1)

    loader.load()
    expect(loader.count()).toBe(1)
  })

  it('treats a file without frontmatter as an always-on rule', () => {
    writeRule('plain.md', 'No frontmatter here.\n')

    const loader = new RulesLoader(root)
    loader.load()

    // No paths filter → matched even when nothing was touched
    expect(loader.getMatchingRules([]).map((r) => r.name)).toEqual(['plain'])
  })

  it('parses comma-separated paths and description from frontmatter', () => {
    writeRule(
      'auth.md',
      '---\npaths: "src/auth/**, src/crypto/**"\ndescription: Auth rules\n---\nCareful.\n',
    )

    const loader = new RulesLoader(root)
    loader.load()

    expect(loader.getMatchingRules(['src/crypto/aes.ts']).map((r) => r.name)).toEqual(['auth'])
    expect(loader.getMatchingRules(['src/ui/app.tsx'])).toEqual([])
  })
})

describe('RulesLoader — linked worktree', () => {
  // `.mipham/` is gitignored, so a worktree checkout carries no `.mipham/rules`:
  // `git worktree add .mipham/worktrees/w1` was run for real against a scratch
  // repo and the checkout contains no `.mipham/` at all. Reading only `cwd`
  // therefore meant a worktree session saw **zero** project rules, silently.
  const worktree = (name: string): string => {
    const dir = join(root, '.mipham', 'worktrees', name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it('loads the project rules when cwd is inside a worktree', () => {
    writeRule('always.md', 'Project-wide.\n')

    const loader = new RulesLoader(worktree('w1'))
    loader.load()

    expect(loader.list()).toEqual(['always'])
    expect(loader.buildContextBlock([])).toContain('Project-wide.')
  })

  it('prefers a worktree-local rule over the project rule of the same name', () => {
    writeRule('always.md', 'From the project.\n')
    const wt = worktree('w2')
    mkdirSync(join(wt, '.mipham', 'rules'), { recursive: true })
    writeFileSync(join(wt, '.mipham', 'rules', 'always.md'), 'From the worktree.\n')

    const loader = new RulesLoader(wt)
    loader.load()

    expect(loader.list()).toEqual(['always'])
    expect(loader.buildContextBlock([])).toContain('From the worktree.')
    expect(loader.buildContextBlock([])).not.toContain('From the project.')
  })

  it('does not reach for a project root from an ordinary subdirectory', () => {
    writeRule('always.md', 'Project-wide.\n')

    // `/proj/src` is not a worktree marker path ⇒ no fallback, and no
    // `.mipham/rules` of its own ⇒ nothing loads.
    const loader = new RulesLoader(join(root, 'src'))
    loader.load()

    expect(loader.count()).toBe(0)
  })
})

describe('RulesLoader — path matching', () => {
  it('matches a rule only against files its glob covers', () => {
    writeRule('cli.md', '---\npaths: "apps/cli/src/**/*.ts"\n---\nCLI rules.\n')

    const loader = new RulesLoader(root)
    loader.load()

    expect(loader.getMatchingRules(['apps/cli/src/core/engine.ts']).map((r) => r.name)).toEqual([
      'cli',
    ])
    expect(loader.getMatchingRules(['docs/readme.md'])).toEqual([])
  })

  it('always-on rules are included alongside matching ones', () => {
    writeRule('always.md', 'Global.')
    writeRule('ts.md', '---\npaths: "*.ts"\n---\nTS only.\n')

    const loader = new RulesLoader(root)
    loader.load()

    expect(
      loader
        .getMatchingRules(['src/a.ts'])
        .map((r) => r.name)
        .sort(),
    ).toEqual(['always', 'ts'])
    // No touched file → the always-on rule still applies
    expect(loader.getMatchingRules([]).map((r) => r.name)).toEqual(['always'])
  })

  it('does not duplicate a rule matched by several touched files', () => {
    writeRule('ts.md', '---\npaths: "*.ts"\n---\nTS only.\n')

    const loader = new RulesLoader(root)
    loader.load()

    expect(loader.getMatchingRules(['src/a.ts', 'src/b.ts']).map((r) => r.name)).toEqual(['ts'])
  })
})

describe('RulesLoader — context block', () => {
  it('renders each matched rule with its name and description', () => {
    writeRule('ts.md', '---\npaths: "*.ts"\ndescription: TS standards\n---\nUse strict mode.\n')

    const loader = new RulesLoader(root)
    loader.load()

    const block = loader.buildContextBlock(['src/a.ts'])
    expect(block).toContain('[Rule: ts] — TS standards')
    expect(block).toContain('Use strict mode.')
    expect(block).toContain('Path-scoped rules matching: src/a.ts')
  })

  it('returns an empty string when nothing matches', () => {
    writeRule('cli.md', '---\npaths: "apps/cli/**"\n---\nCLI rules.\n')

    const loader = new RulesLoader(root)
    loader.load()

    expect(loader.buildContextBlock(['docs/readme.md'])).toBe('')
  })
})
