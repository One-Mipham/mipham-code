import { describe, it, expect, vi, afterEach } from 'vitest'

// Isolate from the real ~/.mipham — the executor reads the user-level
// credential-masking policy from there.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-hooks-fail-closed`,
  }
})

import { executeHook } from '../../src/core/hooks-executor'
import { loadHookConfigs } from '../../src/core/hooks-config'
import { HookEngine } from '../../src/core/hooks'
import { McpClient } from '../../src/mcp/client'
import type { HookContext, HookDefinition } from '../../src/shared/index.ts'

/**
 * A guard that cannot run has not decided.
 *
 * Every path below used to report "the hook failed" *and* `allowed: true`, so a
 * `PreToolUse` guard could be missing, unspawnable, timed out, or pointed at an
 * unreachable server and the call went through anyway. The policy is
 * event-scoped: `PreToolUse` fails closed, every other event observes something
 * that already happened and keeps the old fail-open behaviour. `failureMode:
 * 'open'` opts one guard back out.
 */

const ctx = (event: HookContext['event'] = 'PreToolUse'): HookContext => ({
  event,
  toolName: 'Bash',
  toolInput: {},
  sessionId: 's1',
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a command guard that cannot start', () => {
  it('blocks the call when the binary is missing', async () => {
    const r = await executeHook(
      { type: 'command', command: 'mipham-no-such-binary-xyz' },
      ctx(),
      'my-plugin',
    )

    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('could not run')
    expect(r.reason).toContain('failureMode')
    // The diagnosis is not lost on the blocking path.
    expect(r.additionalContext).toContain('my-plugin')
    expect(r.hookError).toBeTruthy()
  })

  it('still blocks after the executor succeeds and the hook times out', async () => {
    const r = await executeHook(
      { type: 'command', command: '/bin/sh', args: ['-c', 'sleep 5'], timeout: 1 },
      ctx(),
    )

    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('timed out after 1s')
  })

  it('blocks when the hook has no command at all', async () => {
    const r = await executeHook({ type: 'command' }, ctx())

    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('no command configured')
  })

  it('keeps the old fail-open behaviour on a non-guard event', async () => {
    const r = await executeHook(
      { type: 'command', command: 'mipham-no-such-binary-xyz' },
      ctx('PostToolUse'),
    )

    expect(r.allowed).toBe(true)
    expect(r.hookError).toBeTruthy()
    expect(r.additionalContext).toContain('Hook error')
  })

  it('opts one guard back out with failureMode: open', async () => {
    const r = await executeHook(
      { type: 'command', command: 'mipham-no-such-binary-xyz', failureMode: 'open' },
      ctx(),
    )

    expect(r.allowed).toBe(true)
    expect(r.hookError).toBeTruthy()
  })

  it('leaves exit code 1 non-blocking — the hook ran and chose to warn', async () => {
    // The boundary of this change: "could not run" fails closed, "ran and
    // reported a non-blocking error" keeps its exit-1 semantics.
    const r = await executeHook(
      { type: 'command', command: '/bin/sh', args: ['-c', 'echo nope >&2; exit 1'] },
      ctx(),
    )

    expect(r.allowed).toBe(true)
    expect(r.additionalContext).toContain('Hook warning')
    expect(r.additionalContext).toContain('nope')
  })
})

describe('an HTTP guard that cannot be reached', () => {
  it('blocks the call on a transport failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    const r = await executeHook({ type: 'http', url: 'https://guard.invalid/hook' }, ctx())

    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('ECONNREFUSED')
  })

  it('keeps reporting the failure as context on a non-guard event', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))

    const r = await executeHook(
      { type: 'http', url: 'https://guard.invalid/hook' },
      ctx('PostToolUse'),
    )

    expect(r.allowed).toBe(true)
    expect(r.additionalContext).toContain('ECONNREFUSED')
  })

  it('blocks a guard with no url configured', async () => {
    const r = await executeHook({ type: 'http' }, ctx())

    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('no url configured')
  })
})

describe('an MCP guard whose server never answers', () => {
  it('blocks the call while the server is still connecting', async () => {
    vi.spyOn(McpClient.getInstance(), 'waitUntilReady').mockResolvedValue(false)

    const r = await executeHook({ type: 'mcp_tool', mcpServer: 'guard', mcpTool: 'check' }, ctx())

    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('still connecting')
  })

  it('blocks a guard with no server or tool configured', async () => {
    const r = await executeHook({ type: 'mcp_tool' }, ctx())

    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('no mcpServer/mcpTool configured')
  })
})

describe('the engine’s own failure paths follow the same policy', () => {
  const throwing = (failureMode?: 'open' | 'closed'): HookDefinition => ({
    event: 'PreToolUse',
    failureMode,
    handler: async () => {
      throw new Error('handler exploded')
    },
  })

  it('keeps blocking after a guard is auto-disabled for repeated failures', async () => {
    const engine = new HookEngine()
    engine.register(throwing())

    // MAX_CONSECUTIVE_FAILURES is 5; the sixth call takes the skip path.
    for (let i = 0; i < 5; i++) {
      expect((await engine.executePreToolUse('Bash', {}, 's')).allowed).toBe(false)
    }
    const skipped = await engine.executePreToolUse('Bash', {}, 's')

    // Skipping a broken hook must not quietly reopen the gate the five failures
    // just closed.
    expect(skipped.allowed).toBe(false)
    expect(skipped.reason).toContain('temporarily disabled')
  })

  it('an opted-open guard is skipped rather than blocking once disabled', async () => {
    const engine = new HookEngine()
    engine.register(throwing('open'))

    for (let i = 0; i < 5; i++) {
      expect((await engine.executePreToolUse('Bash', {}, 's')).allowed).toBe(true)
    }
    const skipped = await engine.executePreToolUse('Bash', {}, 's')

    expect(skipped.allowed).toBe(true)
    expect(skipped.additionalContext).toContain('skipped')
  })
})

describe('failureMode reaches the definition the engine reads', () => {
  it('carries the setting from settings.json through loadHookConfigs', () => {
    const defs = loadHookConfigs({
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'guard.sh', failureMode: 'open' }],
        },
      ],
    })

    // Auto-disable and thrown handlers read the definition, not the config.
    expect(defs[0]!.failureMode).toBe('open')
  })
})
