import { describe, it, expect, vi, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { executeHook } from '../../src/core/hooks-executor'
import type { HookContext } from '../../src/shared/index.ts'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))

const spawnSyncMock = spawnSync as unknown as ReturnType<typeof vi.fn>

const preCtx = {
  event: 'PreToolUse',
  toolName: 'Bash',
  toolInput: { command: 'npm test' },
  sessionId: 's1',
} as HookContext

function lastSpawnOpts() {
  return spawnSyncMock.mock.calls[0]![2] as { input: string; stdio: string[] }
}

beforeEach(() => {
  spawnSyncMock.mockReset()
})

describe('executeHook command (Claude stdin/stdout protocol)', () => {
  it('passes the Claude-protocol stdin JSON to the script', async () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' })

    await executeHook({ type: 'command', command: 'hook.sh', args: [] }, preCtx)

    const opts = lastSpawnOpts()
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    const input = JSON.parse(opts.input) as Record<string, unknown>
    expect(input.session_id).toBe('s1')
    expect(input.hook_event_name).toBe('PreToolUse')
    expect(input.tool_name).toBe('Bash')
    expect(input.tool_input).toEqual({ command: 'npm test' })
  })

  it('parses a deny decision from stdout into allowed:false', async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Blocked by policy',
        },
      }),
      stderr: '',
    })

    const r = await executeHook({ type: 'command', command: 'hook.sh', args: [] }, preCtx)
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('Blocked by policy')
  })

  it('parses an allow + updatedInput decision into modifiedInput', async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { command: 'npm run lint' },
        },
      }),
      stderr: '',
    })

    const r = await executeHook({ type: 'command', command: 'hook.sh', args: [] }, preCtx)
    expect(r.allowed).toBe(true)
    expect(r.modifiedInput).toEqual({ command: 'npm run lint' })
  })

  it('still blocks on exit code 2 with stderr as reason', async () => {
    spawnSyncMock.mockReturnValue({ status: 2, stdout: '', stderr: 'destructive command' })

    const r = await executeHook({ type: 'command', command: 'hook.sh', args: [] }, preCtx)
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('destructive command')
  })
})
