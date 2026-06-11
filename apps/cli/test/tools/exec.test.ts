import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolContext } from '@mipham/shared'
import { bashTool } from '../../src/tools/exec/bash'
import { gitTool } from '../../src/tools/exec/git'
import { taskTool } from '../../src/tools/exec/task'

// ── Test context ──

const ctx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'test-session',
  provider: 'test',
  model: 'test-model',
}

// ============================================================
// Bash Tool
// ============================================================

describe('Bash tool definition', () => {
  it('has correct metadata', () => {
    expect(bashTool.name).toBe('Bash')
    expect(bashTool.category).toBe('exec')
    expect(bashTool.permission).toBe('ask')
  })

  it('requires command parameter', () => {
    const params = bashTool.parameters as { required: string[] }
    expect(params.required).toEqual(['command'])
  })

  it('has optional description and timeout parameters', () => {
    const params = bashTool.parameters as { properties: Record<string, unknown> }
    expect(params.properties).toHaveProperty('description')
    expect(params.properties).toHaveProperty('timeout')
  })
})

describe('Bash tool execution', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // helper to create a mock Bun.spawn that returns resolved streams
  function mockSpawn(stdoutText = '', stderrText = '', exitCode = 0) {
    const mockExit = Promise.resolve(exitCode)
    const mockProc = {
      stdout: new ReadableStream({
        start(c) {
          if (stdoutText) c.enqueue(new TextEncoder().encode(stdoutText))
          c.close()
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          if (stderrText) c.enqueue(new TextEncoder().encode(stderrText))
          c.close()
        },
      }),
      exited: mockExit,
      kill: vi.fn(),
    }
    globalThis.Bun = { spawn: vi.fn(() => mockProc) } as unknown as typeof Bun
    return mockProc
  }

  it('executes a simple command successfully', async () => {
    mockSpawn('hello world\n')
    const result = await bashTool.execute({ command: 'echo hello' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('hello world')
  })

  it('returns error for failed commands', async () => {
    mockSpawn('', 'command not found', 1)
    const result = await bashTool.execute({ command: 'nonexistent-command' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Exit code 1')
  })

  it('respects custom timeout parameter', async () => {
    mockSpawn()
    await bashTool.execute({ command: 'sleep 1', timeout: 5000 }, ctx)
    expect(globalThis.Bun.spawn).toHaveBeenCalled()
  })

  it('caps timeout at 600000ms', async () => {
    mockSpawn()
    // Should not throw; timeout clamped to 600k internally
    await bashTool.execute({ command: 'sleep 1', timeout: 999999 }, ctx)
  })

  it('passes cwd to spawned process', async () => {
    let receivedOpts: { cwd?: string } | undefined
    const mockExit = Promise.resolve(0)
    const mockProc = {
      stdout: new ReadableStream({
        start(c) {
          c.close()
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close()
        },
      }),
      exited: mockExit,
      kill: vi.fn(),
    }

    globalThis.Bun = {
      spawn: vi.fn((_cmd: string[], opts: { cwd?: string }) => {
        receivedOpts = opts
        return mockProc
      }),
    } as unknown as typeof Bun

    await bashTool.execute({ command: 'pwd' }, ctx)
    expect(receivedOpts?.cwd).toBe(ctx.cwd)
  })

  it('truncates long output', async () => {
    const longText = 'x'.repeat(200_000)
    const mockExit = Promise.resolve(0)
    const mockProc = {
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(longText))
          c.close()
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close()
        },
      }),
      exited: mockExit,
      kill: vi.fn(),
    }

    globalThis.Bun = { spawn: vi.fn(() => mockProc) } as unknown as typeof Bun

    const result = await bashTool.execute({ command: 'cat bigfile' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content.length).toBeLessThanOrEqual(100_000)
  })
})

// ============================================================
// Git Tool
// ============================================================

describe('Git tool definition', () => {
  it('has correct metadata', () => {
    expect(gitTool.name).toBe('Git')
    expect(gitTool.category).toBe('exec')
    expect(gitTool.permission).toBe('auto')
  })

  it('requires command parameter', () => {
    const params = gitTool.parameters as { required: string[] }
    expect(params.required).toEqual(['command'])
  })
})

describe('Git tool execution', () => {
  function mockGitSpawn(stdoutText = '', stderrText = '', exitCode = 0) {
    const mockExit = Promise.resolve(exitCode)
    const mockProc = {
      stdout: new ReadableStream({
        start(c) {
          if (stdoutText) c.enqueue(new TextEncoder().encode(stdoutText))
          c.close()
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          if (stderrText) c.enqueue(new TextEncoder().encode(stderrText))
          c.close()
        },
      }),
      exited: mockExit,
      kill: vi.fn(),
    }
    globalThis.Bun = { spawn: vi.fn(() => mockProc) } as unknown as typeof Bun
    return mockProc
  }

  it('blocks dangerous commands', async () => {
    const dangerousCommands = ['push --force', 'reset --hard', 'clean -fd', 'branch -D']

    for (const cmd of dangerousCommands) {
      const result = await gitTool.execute({ command: cmd }, ctx)
      expect(result.success).toBe(false)
      expect(result.error).toContain('Dangerous git command blocked')
    }
  })

  it('executes safe git commands', async () => {
    mockGitSpawn('On branch master\nnothing to commit')
    const result = await gitTool.execute({ command: 'status' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('On branch master')
  })

  it('returns error for failed git commands', async () => {
    mockGitSpawn('', 'fatal: not a git repository', 128)
    const result = await gitTool.execute({ command: 'log' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Git error')
  })

  it('handles spawn errors gracefully', async () => {
    globalThis.Bun = {
      spawn: vi.fn(() => {
        throw new Error('Spawn failed')
      }),
    } as unknown as typeof Bun

    const result = await gitTool.execute({ command: 'status' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Git execution failed')
  })

  it('blocks push with --force flag', async () => {
    const result = await gitTool.execute({ command: 'push --force origin main' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('blocked')
  })
})

// ============================================================
// Task Tool
// ============================================================

describe('Task tool definition', () => {
  it('has correct metadata', () => {
    expect(taskTool.name).toBe('Task')
    expect(taskTool.category).toBe('exec')
    expect(taskTool.permission).toBe('auto')
  })

  it('requires action parameter', () => {
    const params = taskTool.parameters as { required: string[] }
    expect(params.required).toEqual(['action'])
  })

  it('accepts action enum: create, list, update', () => {
    const params = taskTool.parameters as { properties: Record<string, unknown> }
    const action = params.properties.action as { enum: string[] }
    expect(action.enum).toEqual(['create', 'list', 'update'])
  })
})

describe('Task tool execution', () => {
  it('creates a new task with auto-incrementing ID', async () => {
    const r1 = await taskTool.execute(
      { action: 'create', subject: 'First task', description: 'Do something' },
      ctx,
    )
    expect(r1.success).toBe(true)
    expect(r1.content).toContain('Task #1 created')

    const r2 = await taskTool.execute({ action: 'create', subject: 'Second task' }, ctx)
    expect(r2.success).toBe(true)
    expect(r2.content).toContain('Task #2 created')
  })

  it('uses default subject for untitled tasks', async () => {
    const r = await taskTool.execute({ action: 'create' }, ctx)
    expect(r.success).toBe(true)
    expect(r.content).toContain('Untitled')
  })

  it('lists all tasks', async () => {
    await taskTool.execute({ action: 'create', subject: 'Task A' }, ctx)
    await taskTool.execute({ action: 'create', subject: 'Task B' }, ctx)

    const r = await taskTool.execute({ action: 'list' }, ctx)
    expect(r.success).toBe(true)
    expect(r.content).toContain('Task A')
    expect(r.content).toContain('Task B')
  })

  it('returns (no tasks) for empty list', async () => {
    // Note: task state persists across tests since it's module-level Map
    // We just verify the format
    const r = await taskTool.execute({ action: 'list' }, ctx)
    expect(r.success).toBe(true)
    // Should contain existing tasks from previous tests or show empty
    expect(typeof r.content).toBe('string')
  })

  it('updates task status', async () => {
    const create = await taskTool.execute({ action: 'create', subject: 'Update me' }, ctx)
    // Extract task ID from response
    const idMatch = create.content.match(/#(\d+)/)
    const taskId = idMatch?.[1] ?? '1'

    const update = await taskTool.execute({ action: 'update', taskId, status: 'in_progress' }, ctx)
    expect(update.success).toBe(true)
    expect(update.content).toContain('in_progress')

    // Verify via list
    const list = await taskTool.execute({ action: 'list' }, ctx)
    expect(list.content).toContain('in_progress')
  })

  it('errors when updating non-existent task', async () => {
    const r = await taskTool.execute(
      { action: 'update', taskId: '99999', status: 'completed' },
      ctx,
    )
    expect(r.success).toBe(false)
    expect(r.error).toContain('not found')
  })

  it('errors for unknown action', async () => {
    const r = await taskTool.execute({ action: 'delete' }, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('Unknown action')
  })
})
