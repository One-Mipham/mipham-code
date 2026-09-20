import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  CrsiSandbox,
  validateBlastRadius,
  isProtectedPath,
  PROTECTED_ROLES,
  PROTECTED_PATHS,
  measureScaffold,
} from '../../src/core/crsi-sandbox'
import { LESSONS_FILE, MANAGED_RULES_FILE } from '../../src/core/crsi-producer'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

// Isolate the sandbox report dir from the real ~/.mipham — finalize() persists
// session reports to ~/.mipham/crsi-sandbox, which would accumulate real files.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-crsi-sandbox`,
  }
})

// The worktree is a full monorepo copy. The test runs from apps/cli/,
// but the worktree root is the repo root. So file paths are relative to
// the repo root: apps/cli/README.md = worktree_root/apps/cli/README.md.
// We read original content from CWD-relative paths: README.md = apps/cli/README.md.
const WORKTREE_FILE = 'apps/cli/README.md'
const CWD_FILE = 'README.md'

describe('validateBlastRadius (完整覆盖闸)', () => {
  it('rejects a missing blast radius', () => {
    expect(validateBlastRadius({ blastRadius: undefined })).toBeTruthy()
  })

  it('rejects an empty blast radius', () => {
    expect(validateBlastRadius({ blastRadius: [] })).toBeTruthy()
  })

  it('accepts a non-empty blast radius', () => {
    expect(validateBlastRadius({ blastRadius: ['a.ts', 'b.ts'] })).toBeNull()
  })

  it('rejects when blastRadius does not cover the target filePath', () => {
    expect(
      validateBlastRadius({
        filePath: 'apps/cli/src/foo.ts',
        blastRadius: ['apps/cli/src/bar.ts'],
      }),
    ).toBeTruthy()
  })

  it('accepts when blastRadius covers the target filePath exactly', () => {
    expect(
      validateBlastRadius({
        filePath: 'apps/cli/src/foo.ts',
        blastRadius: ['apps/cli/src/foo.ts'],
      }),
    ).toBeNull()
  })

  it('accepts when blastRadius covers the target filePath by directory prefix', () => {
    expect(
      validateBlastRadius({
        filePath: 'apps/cli/test/foo.test.ts',
        blastRadius: ['apps/cli/test/'],
      }),
    ).toBeNull()
  })
})

describe('measureScaffold (脚手架计数)', () => {
  it('教训文件 → 数 `## ` 段数，不计字节', () => {
    const c = '## a: 1\n\n### 证据\n\n- x\n\n## b: 2\n'
    const m = measureScaffold(LESSONS_FILE, c)
    expect(m.lessons).toBe(2)
    expect(m.rules).toBe(0)
    // 字节刻意不计：合并会重写散文，字节随措辞涨落 —— 计入会让「删二增一」
    // 因新段更长而被误拦，即闸挡掉它本该允许的那件事。
    expect(m.bytes).toBe(0)
  })

  it('`### ` 不算一段（与 removeLessonSections 的口径一致）', () => {
    expect(measureScaffold(LESSONS_FILE, '### 证据\n\n## a: 1\n').lessons).toBe(1)
  })

  it("受管理规则文件 → 数 `id: '` 条数", () => {
    const c = "{\n  id: 'a',\n}, {\n  id: 'b',\n}\n"
    const m = measureScaffold(MANAGED_RULES_FILE, c)
    expect(m.rules).toBe(2)
    expect(m.lessons).toBe(0)
    expect(m.bytes).toBe(0)
  })

  it('受管理规则文件的条数随输入变，不是常数 2', () => {
    // 上面那条只喂了一个 2 条的夹具 —— 单一取值下「数出来的 2」与「写死的 2」不可区分。
    // 下面两个输入（1 / 0 条）才是让那条硬编码现形的那一半。
    expect(measureScaffold(MANAGED_RULES_FILE, "{\n  id: 'a',\n}\n").rules).toBe(1)
    expect(measureScaffold(MANAGED_RULES_FILE, 'export const RULES: unknown[] = []\n').rules).toBe(
      0,
    )
  })

  it('分派按解析后的路径：`./` 前缀与绝对形式同样算作教训文件', () => {
    // 字面量比较时这两种写法都会静默落到 **字节** 分支 —— 而那正是注释里说
    // 绝不该用在教训文件上的那把尺子（示例：'./apps/cli/crsi-lessons.md' 得 lessons 0）。
    // 兄弟守卫 isProtectedPath 同样先规范化再比。
    expect(measureScaffold('./apps/cli/crsi-lessons.md', '## a: 1\n').lessons).toBe(1)
    expect(measureScaffold(resolve(LESSONS_FILE), '## a: 1\n').lessons).toBe(1)
  })

  it('其余文件（skill 等）→ 退到 UTF-8 字节数', () => {
    const m = measureScaffold('apps/cli/skills/standard/memory.SKILL.md', 'abc')
    expect(m.bytes).toBe(3)
    expect(m.lessons).toBe(0)
    expect(m.rules).toBe(0)
  })

  it('多字节按字节数不按字符数', () => {
    // '悲' 是 3 字节。写成 content.length 会得 1 —— 那是另一个对象的读数。
    expect(measureScaffold('x.md', '悲').bytes).toBe(3)
  })

  it('fallback 的字节数随输入变，不是常数 3', () => {
    // 上面两条 fallback 用例喂的都是 3 字节的输入（'abc' / '悲'）—— 两者读数相同，
    // 没有跨越被测值：把 fallback 写成 `return { ..., bytes: 3 }` 它们照样全绿。
    // 下面两个输入（2 / 5 字节）才是让那条硬编码现形的那一半。
    expect(measureScaffold('x.md', 'ab').bytes).toBe(2)
    expect(measureScaffold('x.md', '悲ab').bytes).toBe(5)
  })
})

describe('CrsiSandbox', () => {
  let sandbox: CrsiSandbox

  beforeEach(() => {
    sandbox = new CrsiSandbox()
  })

  afterEach(() => {
    // Always clean up worktree
    try {
      sandbox.removeWorktree()
    } catch {
      // best-effort
    }
  })

  describe('createWorktree', () => {
    it('should create an isolated git worktree and return its path', () => {
      const { worktreePath, branch } = sandbox.createWorktree()

      expect(existsSync(worktreePath)).toBe(true)
      expect(branch).toContain('crsi-sandbox-')

      // Verify it's a real git worktree
      expect(existsSync(join(worktreePath, '.git'))).toBe(true)
      expect(existsSync(join(worktreePath, WORKTREE_FILE))).toBe(true)
    })
  })

  describe('applyModification', () => {
    it('should fail if no worktree is created', () => {
      const result = sandbox.applyModification({
        id: 'test-mod-1',
        description: 'Test modification',
        filePath: WORKTREE_FILE,
        newContent: '{}',
        originalContent: '{}',
        timestamp: new Date().toISOString(),
      })

      expect(result.applied).toBe(false)
      expect(result.phase).toBe('pending')
      expect(result.error).toContain('No worktree created')
    })

    it('should apply a modification in the worktree without touching the real file', () => {
      sandbox.createWorktree()

      // Read the real package.json first
      const originalContent = readFileSync(CWD_FILE, 'utf-8')

      const result = sandbox.applyModification({
        id: 'test-mod-2',
        description: 'Safe test modification in worktree',
        filePath: WORKTREE_FILE,
        newContent: '{"name": "crsi-test-modified", "version": "99.99.99"}',
        originalContent,
        timestamp: new Date().toISOString(),
      })

      expect(result.applied).toBe(true)
      expect(result.phase).toBe('applied')
      expect(result.diff).toBeTruthy()
      expect(result.diff).toContain('crsi-test-modified')

      // Verify the real file is UNCHANGED
      const realContent = readFileSync(CWD_FILE, 'utf-8')
      expect(realContent).toBe(originalContent)
      expect(realContent).not.toContain('crsi-test-modified')
    })

    it('should reject if original content does not match (safety check)', () => {
      sandbox.createWorktree()

      const result = sandbox.applyModification({
        id: 'test-mod-3',
        description: 'Should be rejected',
        filePath: WORKTREE_FILE,
        newContent: '{}',
        originalContent: 'this-content-does-not-exist-in-the-real-file-xyz-123',
        timestamp: new Date().toISOString(),
      })

      expect(result.applied).toBe(false)
      expect(result.phase).toBe('failed')
      expect(result.error).toContain('mismatch')
    })

    it('should accept empty original content (lenient mode)', () => {
      sandbox.createWorktree()

      const realContent = readFileSync(CWD_FILE, 'utf-8')

      const result = sandbox.applyModification({
        id: 'test-mod-4',
        description: 'Lenient mode',
        filePath: WORKTREE_FILE,
        newContent: realContent, // No change
        originalContent: '', // Empty = skip check
        timestamp: new Date().toISOString(),
      })

      expect(result.applied).toBe(true)
      expect(result.phase).toBe('applied')
    })

    it('rejects modifications to protected paths (constitution / eval harness / machinery)', () => {
      sandbox.createWorktree()

      const protectedFiles = [
        'apps/cli/src/core/alignment-vocabulary.json',
        'apps/cli/src/core/constitution-loader.ts',
        'apps/cli/src/core/crsi-sandbox.ts',
        'apps/cli/src/agent/effectiveness-tracker.ts',
        'apps/cli/test/core/crsi-sandbox.test.ts',
        // 改进机制自身（2026-08-27 review 补齐：运行时执行/评估器，改掉会削弱 grader）
        'apps/cli/src/core/crsi-modify.ts',
        'apps/cli/src/core/rule-engine.ts',
        'apps/cli/src/core/red-team.ts',
        'apps/cli/src/core/error-signature-db.ts',
        'apps/cli/src/core/preflight-checker.ts',
      ]

      for (const filePath of protectedFiles) {
        const result = sandbox.applyModification({
          id: `prot-${filePath.replace(/[^a-z0-9]/gi, '-')}`,
          description: 'Should be blocked by protected-path guard',
          filePath,
          newContent: '{}',
          originalContent: '',
          timestamp: new Date().toISOString(),
        })

        expect(result.applied).toBe(false)
        expect(result.phase).toBe('failed')
        expect(result.error).toContain('Protected path')
      }
    })

    it('rejects protected paths even when obfuscated with ./ or subdir/../ prefixes', () => {
      sandbox.createWorktree()

      // Raw-string prefix match must not be evaded by a path that resolves back
      // inside the worktree. normalize() canonicalizes these before the guard.
      const obfuscatedPaths = [
        './apps/cli/src/core/crsi-sandbox.ts',
        'apps/cli/src/core/../core/crsi-sandbox.ts',
        './apps/cli/src/core/eval-harness.ts',
      ]

      for (const filePath of obfuscatedPaths) {
        const result = sandbox.applyModification({
          id: `obf-${filePath.replace(/[^a-z0-9]/gi, '-')}`,
          description: 'Should be blocked by protected-path guard (obfuscated path)',
          filePath,
          newContent: '{}',
          originalContent: '',
          timestamp: new Date().toISOString(),
        })

        expect(result.applied).toBe(false)
        expect(result.phase).toBe('failed')
        expect(result.error).toContain('Protected path')
      }
    })
  })

  describe('getDiff', () => {
    it('should return empty string when no worktree exists', () => {
      expect(sandbox.getDiff()).toBe('')
    })

    it('should return a diff after modification', () => {
      sandbox.createWorktree()

      const originalContent = readFileSync(CWD_FILE, 'utf-8')

      sandbox.applyModification({
        id: 'test-diff-mod',
        description: 'Diff test',
        filePath: WORKTREE_FILE,
        newContent: '{"name": "diff-test"}',
        originalContent,
        timestamp: new Date().toISOString(),
      })

      const diff = sandbox.getDiff()
      expect(diff).toBeTruthy()
      expect(diff).toContain('diff-test')
    })
  })

  describe('rollback', () => {
    it('should clean up worktree on rollback', () => {
      const { worktreePath } = sandbox.createWorktree()
      expect(existsSync(worktreePath)).toBe(true)

      const result = sandbox.rollback()
      expect(result.success).toBe(true)

      // Worktree should be cleaned up
      expect(existsSync(worktreePath)).toBe(false)
    })
  })

  describe('finalize', () => {
    it('should produce a session report and clean up', () => {
      const { worktreePath } = sandbox.createWorktree()

      const report = sandbox.finalize()

      expect(report.sessionId).toContain('crsi-session-')
      expect(report.summary.total).toBe(0)
      expect(report.completedAt).toBeTruthy()

      // Worktree should be cleaned up
      expect(existsSync(worktreePath)).toBe(false)
    })

    it('should persist report to disk', () => {
      sandbox.createWorktree()

      const report = sandbox.finalize()

      // Check the report file exists
      const reportPath = join(homedir(), '.mipham', 'crsi-sandbox', `${report.sessionId}.json`)
      expect(existsSync(reportPath)).toBe(true)
    })
  })

  describe('getDiff without modifications', () => {
    it('should return empty for clean worktree', () => {
      sandbox.createWorktree()
      const diff = sandbox.getDiff()
      expect(diff).toBe('') // No changes yet
    })
  })

  describe('session tracking', () => {
    it('should track modifications throughout the session', () => {
      sandbox.createWorktree()
      const originalContent = readFileSync(CWD_FILE, 'utf-8')

      // Apply 3 modifications
      sandbox.applyModification({
        id: 'mod-a',
        description: 'Change A',
        filePath: WORKTREE_FILE,
        newContent: '{"a": 1}',
        originalContent,
        timestamp: new Date().toISOString(),
      })

      sandbox.applyModification({
        id: 'mod-b',
        description: 'Change B',
        filePath: WORKTREE_FILE,
        newContent: '{"b": 2}',
        originalContent: '', // lenient
        timestamp: new Date().toISOString(),
      })

      sandbox.applyModification({
        id: 'mod-c',
        description: 'Change C (known mismatch)',
        filePath: WORKTREE_FILE,
        newContent: '{}',
        originalContent: 'wrong-content',
        timestamp: new Date().toISOString(),
      })

      const report = sandbox.getReport()
      expect(report.summary.total).toBe(3)
      expect(report.summary.applied).toBe(2)
      expect(report.modifications).toHaveLength(3)
    })
  })
})

describe('PROTECTED_ROLES (语义保护清单)', () => {
  it('三类齐全且 PROTECTED_PATHS = flatten 三类', () => {
    expect(Object.keys(PROTECTED_ROLES)).toEqual(['constitution', 'evaluator', 'selfImprovement'])
    expect(PROTECTED_PATHS).toEqual(Object.values(PROTECTED_ROLES).flat())
    expect(PROTECTED_PATHS.length).toBe(Object.values(PROTECTED_ROLES).flat().length)
  })

  it('补齐的评估器/机制文件已被保护', () => {
    const newlyProtected = [
      'apps/cli/src/core/task-performance.ts',
      'apps/cli/src/core/task-performance-tasks.json',
      'apps/cli/src/core/improvement-track.ts',
      'apps/cli/src/core/reward-fn.ts',
      'apps/cli/src/agent/recoverable-failure.ts',
      'apps/cli/src/agent/crsi-provenance-bridge.ts',
    ]
    for (const f of newlyProtected) expect(isProtectedPath(f)).toBe(true)
  })

  it('可编辑补充（producer 产物）不被保护', () => {
    expect(isProtectedPath('apps/cli/src/core/crsi-managed-rules.ts')).toBe(false)
    expect(isProtectedPath('apps/cli/crsi-lessons.md')).toBe(false)
  })
})
