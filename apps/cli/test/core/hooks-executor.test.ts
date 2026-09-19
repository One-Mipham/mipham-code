import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Isolate from the real ~/.mipham — the executor reads the user-level
// credential-masking policy from there.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-hooks-executor`,
  }
})

type SpawnOptions = {
  env?: Record<string, string | undefined>
  cwd?: string
  input?: string
}

// Mock spawnSync so we can exercise the command-hook output path without a real
// subprocess (and deterministically emit a large stderr). Captured rather than
// discarded: the hook's *spawn options* are themselves a security surface — but
// only if the mock's signature declares them, or `mock.calls[0][2]` types as
// "no index 2" and the assertion below cannot be written at all.
const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn((_cmd: string, _args: string[], _options: SpawnOptions) => ({
    status: 1,
    stdout: '',
    stderr: 'x'.repeat(5000),
  })),
}))

vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }))

import { executeHook } from '../../src/core/hooks-executor'
import { CREDENTIAL_SENTINEL } from '../../src/core/credential-masker'
import type { HookContext } from '../../src/shared/index.ts'

const ctx = {
  event: 'PostToolUse',
  toolName: 'Bash',
  toolInput: {},
  sessionId: 's1',
} as HookContext

describe('executeHook (command)', () => {
  it('truncates oversized stderr so MB output cannot overflow the session', async () => {
    const result = await executeHook({ type: 'command', command: 'my-hook', args: [] }, ctx)

    expect(result.allowed).toBe(true)
    expect(result.additionalContext).toBeDefined()
    // 2000-char cap + the "Hook warning (my-hook): " prefix (~24 chars) — must
    // stay far below the 5000-char stderr that would otherwise be injected.
    expect(result.additionalContext!.length).toBeLessThan(2100)
  })
})

/**
 * A hook command is a subprocess of the CLI/daemon, so a bare `spawnSync` hands
 * it the parent's whole environment — every provider API key and bot secret
 * included. `filterEnv` has existed since the masking work; what was missing was
 * this call site (Bash got it, hooks did not).
 */
describe('executeHook (command) — environment', () => {
  const SECRET = 'sk-live-must-not-travel'
  const BENIGN = 'keep-me'

  beforeEach(() => {
    spawnSyncMock.mockClear()
  })

  afterEach(() => {
    delete process.env.MIPHAM_HOOK_PROBE_API_KEY
    delete process.env.MIPHAM_HOOK_PROBE_NAME
  })

  it('withholds credential-bearing env vars from hook subprocesses', async () => {
    process.env.MIPHAM_HOOK_PROBE_API_KEY = SECRET
    process.env.MIPHAM_HOOK_PROBE_NAME = BENIGN

    await executeHook({ type: 'command', command: 'probe-hook', args: [] }, ctx)

    const options = spawnSyncMock.mock.calls[0]![2] as SpawnOptions
    expect(options.env).toBeDefined()
    // The judgement is on the value, not on the key's presence: `filterEnv`
    // replaces in place, so "still in the map" and "still leaked" are not the
    // same claim — asserting only `toBeUndefined()` would have been wrong about
    // the mechanism while looking right about the outcome.
    expect(options.env!.MIPHAM_HOOK_PROBE_API_KEY).toBe(CREDENTIAL_SENTINEL)
    expect(options.env!.MIPHAM_HOOK_PROBE_API_KEY).not.toBe(SECRET)
    expect(Object.values(options.env!)).not.toContain(SECRET)
    // …while the rest of the environment still arrives, so this cannot pass by
    // handing the hook an empty env.
    expect(options.env!.MIPHAM_HOOK_PROBE_NAME).toBe(BENIGN)
  })
})

/**
 * Which workspace a hook runs *for* is not the same question as which one this
 * process was started in. `executeCommand` answered both with `process.cwd()`,
 * which is right for the one-shot CLI and wrong for the daemon — it serves many
 * sessions from one process, and its own cwd belongs to none of them.
 *
 * Two separate surfaces, both wrong in the same direction, so both are asserted:
 * the `cwd` field the hook *reads* out of stdin, and the directory the hook
 * *runs* in. Fixing only one would leave the stdin field claiming a workspace the
 * hook is not actually in.
 */
describe('executeHook (command) — session cwd', () => {
  const SESSION_CWD = '/sessions/probe'

  beforeEach(() => {
    spawnSyncMock.mockClear()
  })

  it('spawns in the session cwd and says so on stdin', async () => {
    await executeHook(
      { type: 'command', command: 'probe-hook', args: [] },
      {
        ...ctx,
        cwd: SESSION_CWD,
      },
    )

    const options = spawnSyncMock.mock.calls[0]![2] as SpawnOptions
    expect(options.cwd).toBe(SESSION_CWD)

    const stdin = JSON.parse(options.input!) as { cwd?: string }
    expect(stdin.cwd).toBe(SESSION_CWD)
    // …and not merely "defined": the wrong value is the specific one this fix is
    // about, and `process.cwd()` is what it used to be.
    expect(options.cwd).not.toBe(process.cwd())
  })

  it('falls back to this process’ cwd when the context carries none', async () => {
    await executeHook({ type: 'command', command: 'probe-hook', args: [] }, ctx)

    const options = spawnSyncMock.mock.calls[0]![2] as SpawnOptions
    expect(options.cwd).toBe(process.cwd())
  })
})
