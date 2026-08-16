import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { CrsiSandbox } from '../../src/core/crsi-sandbox'
import {
  runCrsiModification,
  approvePending,
  rejectPending,
  hasPending,
} from '../../src/core/crsi-modify'

// Isolate the sandbox report dir (matching crsi-sandbox.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-crsi-modify`,
  }
})

// Repo-root-relative path inside the worktree (worktree = full monorepo copy).
const WORKTREE_FILE = 'apps/cli/README.md'

beforeEach(() => {
  // 清空 rewards 日志，避免跨运行残留的旧分数（如 gap 表上线前的 100）触发假退化。
  rmSync(join(homedir(), '.mipham', 'crsi', 'eval-scores.jsonl'), { force: true })
})

afterEach(() => {
  // 安全清理：reject = 回滚 worktree，不触碰真实仓库。
  if (hasPending()) rejectPending()
})

describe('runCrsiModification', () => {
  it('rejects protected paths without running tests', () => {
    const sandbox = new CrsiSandbox()
    const result = runCrsiModification(
      { description: 'blocked', filePath: 'apps/cli/test/foo.test.ts', newContent: '{}' },
      sandbox,
    )
    expect(result.phase).toBe('failed')
    expect(result.error).toContain('Protected path')
    expect(hasPending()).toBe(false)
  })

  it('tests pass → phase passed + diff + pending', () => {
    const sandbox = new CrsiSandbox()
    vi.spyOn(sandbox, 'runTests').mockReturnValue({
      passed: true,
      totalTests: 0,
      failedTests: 0,
      output: '',
    })
    const result = runCrsiModification(
      { description: 'safe change', filePath: WORKTREE_FILE, newContent: 'crsi-modify-test\n' },
      sandbox,
    )
    expect(result.phase).toBe('passed')
    expect(result.diff).toContain('crsi-modify-test')
    expect(hasPending()).toBe(true)
  })

  it('tests fail → phase failed + auto-rollback (no pending)', () => {
    const sandbox = new CrsiSandbox()
    vi.spyOn(sandbox, 'runTests').mockReturnValue({
      passed: false,
      totalTests: 1,
      failedTests: 1,
      output: '',
    })
    const result = runCrsiModification(
      { description: 'failing', filePath: WORKTREE_FILE, newContent: '{}' },
      sandbox,
    )
    expect(result.phase).toBe('failed')
    expect(hasPending()).toBe(false)
  })
})

describe('pending registry', () => {
  it('approve/reject with no pending returns failure', () => {
    expect(approvePending().success).toBe(false)
    expect(rejectPending().success).toBe(false)
  })

  it('reject clears pending after a passed modification', () => {
    const sandbox = new CrsiSandbox()
    vi.spyOn(sandbox, 'runTests').mockReturnValue({
      passed: true,
      totalTests: 0,
      failedTests: 0,
      output: '',
    })
    runCrsiModification(
      { description: 'pending', filePath: WORKTREE_FILE, newContent: 'pending-test\n' },
      sandbox,
    )
    expect(hasPending()).toBe(true)
    const r = rejectPending()
    expect(r.success).toBe(true)
    expect(hasPending()).toBe(false)
  })
})
