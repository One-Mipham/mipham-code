import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
  statSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
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

/**
 * A rule's body is injected into the conversation **verbatim** and shipped to
 * the model provider, so `.mipham/rules/*.md` is an **egress** path that the
 * repository alone controls — not merely a config directory. These tests pin
 * what may be read, and they all carry a positive control (an ordinary file in
 * the same directory must still load) so that a refusal for the wrong reason —
 * a loader that is simply not wired up — cannot read as a pass.
 */
function captureStderr(fn: () => void): string {
  const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    fn()
    return write.mock.calls.map((c) => String(c[0])).join('')
  } finally {
    write.mockRestore()
  }
}

describe('RulesLoader — rule paths must be real regular files', () => {
  let outside: string

  beforeEach(() => {
    // Deliberately *outside* `root`: the symlink escape has to leave the project.
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-rules-outside-')))
  })

  afterEach(() => {
    rmSync(outside, { recursive: true, force: true })
  })

  it('refuses a symlink out of the project, and says which path it refused', () => {
    writeFileSync(join(outside, 'secrets.md'), 'API_KEY=leaked-secret\n')
    const link = join(rulesDir, 'evil.md')
    symlinkSync(join(outside, 'secrets.md'), link)
    writeRule('ok.md', 'Ordinary rule.\n')

    const loader = new RulesLoader(root)
    const printed = captureStderr(() => loader.load())

    expect(loader.list()).toEqual(['ok'])
    expect(loader.buildContextBlock([])).not.toContain('leaked-secret')
    expect(printed).toContain(link)
    expect(printed).toContain('符号链接')
  })

  it('refuses a symlink that stays *inside* the project too', () => {
    // Resolving the link and requiring the target to be inside the project is
    // not a safe rule: the project root is exactly where the user's own
    // gitignored secrets live (`.env`, `.mipham/keys`), so `-> ../../.env`
    // would pass a containment check and still leak. The rule is narrower than
    // that on purpose: a rule must be a plain file, not a link to anything.
    writeFileSync(join(root, '.env'), 'TOKEN=project-local-secret\n')
    symlinkSync(join(root, '.env'), join(rulesDir, 'env.md'))
    writeRule('ok.md', 'Ordinary rule.\n')

    const loader = new RulesLoader(root)
    const printed = captureStderr(() => loader.load())

    expect(loader.list()).toEqual(['ok'])
    expect(loader.buildContextBlock([])).not.toContain('project-local-secret')
    expect(printed).toContain('符号链接')
  })

  it('refuses a directory named `x.md` instead of swallowing the EISDIR', () => {
    mkdirSync(join(rulesDir, 'dir.md'))
    writeRule('ok.md', 'Ordinary rule.\n')

    const loader = new RulesLoader(root)
    const printed = captureStderr(() => loader.load())

    expect(loader.list()).toEqual(['ok'])
    expect(printed).toContain(join(rulesDir, 'dir.md'))
    expect(printed).toContain('不是普通文件')
  })

  it('refuses the whole rules directory when it is reached through a symlink', () => {
    // `.mipham` sits one segment above the entries, so no per-entry check can
    // see `.mipham/rules -> ~/.mipham/memory` — the user's private notes would
    // be injected as project rules.
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'always.md'), 'Injected from elsewhere.\n')
    rmSync(rulesDir, { recursive: true, force: true })
    symlinkSync(elsewhere, rulesDir, 'dir')

    const loader = new RulesLoader(root)
    const printed = captureStderr(() => loader.load())

    expect(loader.count()).toBe(0)
    expect(loader.buildContextBlock([])).not.toContain('Injected from elsewhere')
    expect(printed).toContain('符号链接')
  })

  it('reports a refused path once, not once per load (daemon builds a loader per session)', () => {
    writeFileSync(join(outside, 'secrets.md'), 'API_KEY=leaked-secret\n')
    symlinkSync(join(outside, 'secrets.md'), join(rulesDir, 'evil.md'))

    const printed = captureStderr(() => {
      new RulesLoader(root).load()
      new RulesLoader(root).load()
      new RulesLoader(root).load()
    })

    expect(printed.split('⚠️').length - 1).toBe(1)
  })
})

/**
 * The property under test is **blocking**: `readFileSync` on a FIFO with no
 * writer waits forever, and it does so *synchronously* — vitest's timeout,
 * timers and signal handlers never get to run, so a regression freezes the
 * whole worker. The suite would not go red, it would simply stop moving. The
 * assertion therefore runs in a **subprocess** under a hard timeout (same
 * harness and same reasoning as `test/config/config-fifo.test.ts`): a real
 * regression reads as `signal=SIGTERM`, which *can* fail, instead of as a
 * silent hang.
 *
 * The pass condition is "the subprocess finished and printed its marker", not
 * "it did not time out" — the latter is also true when the subprocess never
 * started (no `bun` on PATH, a syntax error), which would be a false green.
 */
describe('RulesLoader — a FIFO in the rules directory', () => {
  const CLI_DIR = join(import.meta.dirname, '..', '..')
  const WATCHDOG_MS = 15_000
  const PROBE = `
import { RulesLoader } from ${JSON.stringify(join(CLI_DIR, 'src/core/rules-loader.ts'))}
const loader = new RulesLoader(process.argv[2])
loader.load()
console.log('RESULT names=' + loader.list().sort().join(','))
`

  it('does not hang: ordinary rules load, the FIFO is refused by name', () => {
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-rules-fifo-')))
    const dir = join(proj, '.mipham', 'rules')
    mkdirSync(dir, { recursive: true })
    const fifo = join(dir, 'hang.md')
    execFileSync('mkfifo', [fifo])
    // Self-verifying precondition: if `mkfifo` did not produce a FIFO the
    // reading below would be about something else entirely.
    expect(statSync(fifo).isFIFO()).toBe(true)
    writeFileSync(join(dir, 'ok.md'), 'Ordinary rule.\n')

    const script = join(proj, 'probe.ts')
    writeFileSync(script, PROBE)
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of Object.keys(env)) {
      if (key.startsWith('MIPHAM_')) delete env[key]
    }
    const r = spawnSync('bun', [script, proj], {
      cwd: proj,
      env,
      encoding: 'utf-8',
      timeout: WATCHDOG_MS,
      killSignal: 'SIGTERM',
    })
    try {
      expect(r.error?.message).toBeUndefined()
      expect(`${r.signal ?? 'no-signal'} status=${r.status}`).toBe('no-signal status=0')
      expect(r.stdout).toContain('RESULT names=ok')
      expect(r.stderr).toContain(fifo)
      expect(r.stderr).toContain('不是普通文件')
    } finally {
      rmSync(proj, { recursive: true, force: true })
    }
  }, 30_000)
})
