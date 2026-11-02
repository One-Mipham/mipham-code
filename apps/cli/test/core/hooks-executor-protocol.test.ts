import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { executeHook } from '../../src/core/hooks-executor'
import type { HookContext } from '../../src/shared/index.ts'
import { makeFakeHookChild, type FakeHookOutcome } from '../helpers/fake-hook-child'

// A child, not a `spawnSync` result: the executor awaits a life-cycle, so a
// result object would never reach the code under test.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const preCtx = {
  event: 'PreToolUse',
  toolName: 'Bash',
  toolInput: { command: 'npm test' },
  sessionId: 's1',
} as HookContext

let outcome: FakeHookOutcome = { status: 0, stdout: '', stderr: '' }

function lastSpawn() {
  const call = spawnMock.mock.calls[0]!
  return {
    opts: call[2] as { stdio: string[]; detached?: boolean },
    stdin: (spawnMock.mock.results[0]!.value as { written: string[] }).written[0]!,
  }
}

beforeEach(() => {
  outcome = { status: 0, stdout: '', stderr: '' }
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => makeFakeHookChild(outcome))
})

describe('executeHook command (Claude stdin/stdout protocol)', () => {
  it('passes the Claude-protocol stdin JSON to the script', async () => {
    await executeHook({ type: 'command', command: 'hook.sh', args: [] }, preCtx)

    const { opts, stdin } = lastSpawn()
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    const input = JSON.parse(stdin) as Record<string, unknown>
    expect(input.session_id).toBe('s1')
    expect(input.hook_event_name).toBe('PreToolUse')
    expect(input.tool_name).toBe('Bash')
    expect(input.tool_input).toEqual({ command: 'npm test' })
  })

  it('parses a deny decision from stdout into allowed:false', async () => {
    outcome = {
      status: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Blocked by policy',
        },
      }),
      stderr: '',
    }

    const r = await executeHook({ type: 'command', command: 'hook.sh', args: [] }, preCtx)
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('Blocked by policy')
  })

  it('parses an allow + updatedInput decision into modifiedInput', async () => {
    outcome = {
      status: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { command: 'npm run lint' },
        },
      }),
      stderr: '',
    }

    const r = await executeHook({ type: 'command', command: 'hook.sh', args: [] }, preCtx)
    expect(r.allowed).toBe(true)
    expect(r.modifiedInput).toEqual({ command: 'npm run lint' })
  })

  it('floors "timeout": 0 so a working hook is not killed before it can run', async () => {
    // A child that reports success 50ms in: later than a 0ms kill timer, earlier
    // than the 1s floor. Without the floor the hook is torn down first and the
    // operator is told "timed out after 0s" about a hook that worked fine.
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as any
      child.pid = 4343
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = Object.assign(new EventEmitter(), { end: () => {} })
      child.kill = () => {}
      setTimeout(() => {
        child.emit('exit', 0, null)
        child.emit('close', 0, null)
      }, 50)
      return child
    })

    const r = await executeHook(
      { type: 'command', command: 'hook.sh', args: [], timeout: 0 },
      preCtx,
    )
    expect(r.allowed).toBe(true)
  })

  it('still blocks on exit code 2 with stderr as reason', async () => {
    outcome = { status: 2, stdout: '', stderr: 'destructive command' }

    const r = await executeHook({ type: 'command', command: 'hook.sh', args: [] }, preCtx)
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('destructive command')
  })
})
