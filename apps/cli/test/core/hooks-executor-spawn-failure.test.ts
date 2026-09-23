import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Isolate from the real ~/.mipham — the executor reads the user-level
// credential-masking policy from there.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-hooks-executor-spawn-failure`,
  }
})

import { executeHook } from '../../src/core/hooks-executor'
import type { HookContext } from '../../src/shared/index.ts'

const ctx = {
  event: 'PostToolUse',
  toolName: 'Bash',
  toolInput: {},
  sessionId: 's1',
} as HookContext

/**
 * Deliberately **no** mock of `node:child_process` here, unlike its two siblings.
 * The defect being pinned is about which *shape* a real `spawnSync` returns when
 * the child never runs to completion — and a mocked shape is authored by the same
 * hand that wrote the reader, so it cannot disagree with it. These spawn for real
 * (one `sleep` costs the file ~1s) so the assertion is about the contract rather
 * than about my belief about it.
 *
 * All three failures arrive with **empty stderr**, which is why they used to be
 * one string with a benign non-zero exit that printed nothing:
 * `Hook warning (<cmd>): ` — reason left blank, cause unknowable.
 */
describe('executeHook (command) — 子进程没能跑完时，理由是量出来的', () => {
  it('超时可归因，不再是一条空理由', async () => {
    const r = await executeHook(
      { type: 'command', command: '/bin/sh', args: ['-c', 'sleep 5'], timeout: 1 },
      ctx,
    )

    // Non-blocking, as before — this is a diagnosability fix, not a policy change.
    expect(r.allowed).toBe(true)
    expect(r.additionalContext).toContain('timed out after 1s')
    // The pre-fix reading, verbatim: a 1s timeout and `exit 3` with silent stderr
    // both produced exactly this, so `toContain` above would already fail here —
    // this line names the string the defect *was*.
    expect(r.additionalContext).not.toBe('Hook warning (/bin/sh): ')
  })

  it('命令不存在同样是可归因的', async () => {
    const r = await executeHook(
      { type: 'command', command: join(tmpdir(), 'mipham-hook-does-not-exist-xyz') },
      ctx,
    )

    expect(r.allowed).toBe(true)
    expect(r.additionalContext).toContain('ENOENT')
    expect(r.additionalContext).not.toContain('Hook warning')
  })

  it('被信号杀死的子进程点名信号（这条没有 error，只有 signal）', async () => {
    const r = await executeHook(
      { type: 'command', command: '/bin/sh', args: ['-c', 'kill -TERM $$'] },
      ctx,
    )

    expect(r.allowed).toBe(true)
    expect(r.additionalContext).toContain('killed by SIGTERM')
  })

  // 下面三条是正对照：新分支若「顺手改宽」，首先是这三格变色。
  it('真非零退出仍旧逐字是原来那条警告', async () => {
    const r = await executeHook(
      { type: 'command', command: '/bin/sh', args: ['-c', 'echo boom >&2; exit 3'] },
      ctx,
    )

    expect(r.allowed).toBe(true)
    expect(r.additionalContext).toBe('Hook warning (/bin/sh): boom')
  })

  it('退出码 2 仍旧拦截（新分支排在它后面，不能把拦截吃掉）', async () => {
    const r = await executeHook(
      { type: 'command', command: '/bin/sh', args: ['-c', 'echo nope >&2; exit 2'] },
      ctx,
    )

    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('nope')
  })

  it('退出码 0 仍旧是干净的 allowed，不带上下文', async () => {
    const r = await executeHook(
      { type: 'command', command: '/bin/sh', args: ['-c', 'exit 0'] },
      ctx,
    )

    expect(r.allowed).toBe(true)
    expect(r.additionalContext).toBeUndefined()
  })
})
