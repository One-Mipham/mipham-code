import { describe, it, expect, vi } from 'vitest'

// Mock spawnSync so we can exercise the command-hook output path without a real
// subprocess (and deterministically emit a large stderr).
vi.mock('node:child_process', () => ({
  spawnSync: () => ({
    status: 1,
    stdout: '',
    stderr: 'x'.repeat(5000),
  }),
}))

import { executeHook } from '../../src/core/hooks-executor'
import type { HookContext } from '../../src/shared/index.ts'

describe('executeHook (command)', () => {
  it('truncates oversized stderr so MB output cannot overflow the session', async () => {
    const ctx = {
      event: 'PostToolUse',
      toolName: 'Bash',
      toolInput: {},
      sessionId: 's1',
    } as HookContext

    const result = await executeHook({ type: 'command', command: 'my-hook', args: [] }, ctx)

    expect(result.allowed).toBe(true)
    expect(result.additionalContext).toBeDefined()
    // 2000-char cap + the "Hook warning (my-hook): " prefix (~24 chars) — must
    // stay far below the 5000-char stderr that would otherwise be injected.
    expect(result.additionalContext!.length).toBeLessThan(2100)
  })
})
