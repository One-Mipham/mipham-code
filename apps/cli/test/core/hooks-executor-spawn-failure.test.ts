import { describe, it, expect, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
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
 * The defect being pinned is about which *shape* a real child process reports when
 * it never runs to completion — and a mocked shape is authored by the same hand
 * that wrote the reader, so it cannot disagree with it. These spawn for real, and
 * every wait below is bounded to ~1s (a hook timeout, or the pipe grace) so the
 * assertion is about the contract rather than about my belief about it.
 *
 * All three failures arrive with **empty stderr**, which is why they used to be
 * one string with a benign non-zero exit that printed nothing:
 * `Hook warning (<cmd>): ` — reason left blank, cause unknowable.
 *
 * Note that every child below **ignores stdin**, so the write that hands it the
 * payload is racing its exit. On the dev machine the write always won and the
 * shape above is what came back; on CI's faster box it lost and the result also
 * carried `EPIPE` (an error about *our write*, not about the run). The last two
 * cases make that loss certain rather than scheduled, so the reason the child
 * actually produced is pinned on both platforms instead of on one.
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

  /**
   * 钩子自己已经退出了，但它 `&` 出去的后代仍然握着 stdout/stderr —— `spawnSync` 等
   * 的是**管道 EOF**，不是子进程退出，于是这个后代决定我们等多久：实测默认 60s 超时
   * 下走满 60,0xx ms 才回来，而且报的是「钩子超时」——一句误诊。真正的等待上界应当是
   * 钩子本身。
   */
  it('后代握着管道时，等的是钩子不是后代', async () => {
    const started = Date.now()
    const r = await executeHook(
      { type: 'command', command: '/bin/sh', args: ['-c', 'sleep 20 & echo done'] },
      ctx,
    )
    const elapsed = Date.now() - started

    // 钩子自身退出码 0 ⇒ 干净 allowed；非 JSON 的 stdout 不构成决定。
    expect(r.allowed).toBe(true)
    expect(r.additionalContext).toBeUndefined()
    // 两个方向都要断，缺一个这条用例就能空过：
    //   上界 —— 修好后约 1s（那段管道宽容期），坏掉则是 20s（等后代）或 60s（等默认
    //   超时）；5s 把两者分开，且离任何一边都远。
    //   下界 —— 前提自证：**必须**慢到被宽容期拦住。若后代根本没有握着管道（比如
    //   `sh` 没把 fd 继承下去），`close` 会立刻到、用时几十毫秒，这条用例就只是
    //   「绿色」而没有验到它声称的那件事。800ms 远低于宽容期 1000ms 又远高于空过。
    expect(elapsed).toBeLessThan(5_000)
    expect(elapsed).toBeGreaterThanOrEqual(800)
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

  // 下面两条把「写失败」从竞态变成确定：payload 远超 64 KiB 管道缓冲，一个从不读
  // stdin 就退出的子进程必然让写入失败。这不是构造出来的场景 —— 真实 hook 常常
  // 压根不读 stdin（`exit 3`、`kill -TERM $$` 就是），只是大小让它必然发生。
  it('payload 写不进去时，理由是子进程真实说的那句', async () => {
    const input = bigPayload()
    assertWriteLosesTheRace(input)

    const r = await executeHook(
      { type: 'command', command: '/bin/sh', args: ['-c', 'echo boom >&2; exit 3'] },
      { ...ctx, toolInput: JSON.parse(input) } as HookContext,
    )

    // 退出码在，所以理由以退出码为准：EPIPE 不能顶替它。
    expect(r.allowed).toBe(true)
    expect(r.additionalContext).toBe('Hook warning (/bin/sh): boom')
  })

  it('payload 写不进去、子进程又被信号杀死：信号仍然说得清', async () => {
    const input = bigPayload()
    assertWriteLosesTheRace(input)

    const r = await executeHook(
      { type: 'command', command: '/bin/sh', args: ['-c', 'kill -TERM $$'] },
      { ...ctx, toolInput: JSON.parse(input) } as HookContext,
    )

    expect(r.allowed).toBe(true)
    expect(r.additionalContext).toContain('killed by SIGTERM')
  })
})

/** 一个远超管道缓冲（64 KiB）的 stdin payload。 */
function bigPayload(): string {
  return JSON.stringify({ blob: 'x'.repeat(1024 * 1024) })
}

/**
 * 前提自证：按同样的写形状，这个平台**真的**会报 EPIPE。不这样断一句，上面两条
 * 用例在「竞态没输」的机器上会全绿，而它们一个字都没验到。
 */
function assertWriteLosesTheRace(input: string): void {
  const probe = spawnSync('/bin/sh', ['-c', 'exit 3'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input,
  })
  expect((probe.error as { code?: string } | undefined)?.code).toBe('EPIPE')
  // 并且退出码确实与这个 error 并存 —— 判据就是靠这一点把 EPIPE 排除在外的。
  expect(probe.status).toBe(3)
}
