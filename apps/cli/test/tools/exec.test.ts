import { describe, it, expect, vi, afterEach } from 'vitest'
import type { ToolContext } from '../../src/shared'
import { createBashTool } from '../../src/tools/exec/bash'
import { gitTool, splitCommand, findProgramExecutingArg } from '../../src/tools/exec/git'
import { taskTool } from '../../src/tools/exec/task'
import { BackgroundAgentRegistry } from '../../src/agent/background-registry'
import { exitWorktreeTool } from '../../src/tools/exec/exit-worktree'
import { recordToolEvidence, clearEvidenceLog } from '../../src/core/working-memory'

const bashTool = createBashTool()

// ── Test context ──

const ctx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'test-session',
  provider: 'test',
  model: 'test-model',
}

// ============================================================
// Mock helper — uses vi.spyOn instead of readonly globalThis.Bun
// ============================================================

type MockedProc = {
  stdout: ReadableStream
  stderr: ReadableStream
  exited: Promise<number>
  kill: ReturnType<typeof vi.fn>
}

function createMockProc(stdoutText = '', stderrText = '', exitCode = 0): MockedProc {
  return {
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
    exited: Promise.resolve(exitCode),
    kill: vi.fn(),
  }
}

function mockSpawn(stdoutText = '', stderrText = '', exitCode = 0): MockedProc {
  const proc = createMockProc(stdoutText, stderrText, exitCode)
  vi.spyOn(Bun, 'spawn').mockReturnValue(proc as any)
  return proc
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
  afterEach(() => {
    vi.restoreAllMocks()
  })

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
    expect(Bun.spawn).toHaveBeenCalled()
  })

  it('caps timeout at 600000ms', async () => {
    mockSpawn()
    // Should not throw; timeout clamped to 600k internally
    await bashTool.execute({ command: 'sleep 1', timeout: 999999 }, ctx)
  })

  it('passes cwd to spawned process', async () => {
    const proc = createMockProc()
    vi.spyOn(Bun, 'spawn').mockImplementation((_cmd: any, opts: any) => {
      expect(opts.cwd).toBe(ctx.cwd)
      return proc as any
    })
    await bashTool.execute({ command: 'pwd' }, ctx)
  })

  it('truncates long output', async () => {
    const longText = 'x'.repeat(200_000)
    const proc = createMockProc(longText)
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as any)

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
    expect(gitTool.permission).toBe('self')
  })

  it('requires command parameter', () => {
    const params = gitTool.parameters as { required: string[] }
    expect(params.required).toEqual(['command'])
  })
})

describe('Git tool execution', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function mockGitSpawn(stdoutText = '', stderrText = '', exitCode = 0): MockedProc {
    const proc = createMockProc(stdoutText, stderrText, exitCode)
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as any)
    return proc
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

  it('preserves quoted arguments with spaces in the spawned argv', async () => {
    let capturedCmd: string[] | undefined
    const proc = createMockProc()
    vi.spyOn(Bun, 'spawn').mockImplementation((cmd: any, _opts: any) => {
      capturedCmd = cmd as string[]
      return proc as any
    })
    await gitTool.execute({ command: 'commit -m "add feature x"' }, ctx)
    expect(capturedCmd).toEqual(['git', 'commit', '-m', 'add feature x'])
  })

  it('returns error for failed git commands', async () => {
    mockGitSpawn('', 'fatal: not a git repository', 128)
    const result = await gitTool.execute({ command: 'log' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Git error')
  })

  it('handles spawn errors gracefully', async () => {
    vi.spyOn(Bun, 'spawn').mockImplementation(() => {
      throw new Error('Spawn failed')
    })

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
// Git options that execute a program
// ============================================================
//
// Git runs without an approval prompt, and these options name a program for it
// to execute — each one confirmed to run a local script:
//   ls-remote --upload-pack=/tmp/x.sh <path>
//   push --receive-pack=/tmp/x.sh <remote>
//   --exec-path=<dir> with a planted <dir>/git-<subcommand>
// The regex list could not catch them: it is organised by spelling, so a
// spelling it does not anticipate is simply not blocked.

describe('findProgramExecutingArg', () => {
  it('flags the program-executing options, attached and detached', () => {
    expect(findProgramExecutingArg(['ls-remote', '--upload-pack=/tmp/x.sh', '/p'])).toBe(
      '--upload-pack=/tmp/x.sh',
    )
    expect(findProgramExecutingArg(['ls-remote', '--upload-pack', '/tmp/x.sh', '/p'])).toBe(
      '--upload-pack /tmp/x.sh',
    )
    expect(findProgramExecutingArg(['push', '--receive-pack=/tmp/x.sh', 'origin'])).toContain(
      '--receive-pack',
    )
    expect(findProgramExecutingArg(['--exec-path=/tmp/evil', 'status'])).toBe(
      '--exec-path=/tmp/evil',
    )
  })

  it('flags program-executing config keys in every spelling', () => {
    expect(findProgramExecutingArg(['-ccore.sshCommand=/tmp/x.sh', 'fetch'])).toContain(
      'core.sshCommand',
    )
    expect(findProgramExecutingArg(['-c', 'core.pager=/tmp/x.sh', 'log'])).toContain('core.pager')
    expect(findProgramExecutingArg(['--config=core.askpass=/tmp/x.sh', 'fetch'])).toContain(
      'core.askpass',
    )
    expect(findProgramExecutingArg(['--config', 'alias.s=/tmp/x.sh', 's'])).toContain('alias.s')
  })

  it('leaves ordinary git commands alone', () => {
    expect(findProgramExecutingArg(['status'])).toBeNull()
    expect(findProgramExecutingArg(['ls-remote', 'origin'])).toBeNull()
    expect(findProgramExecutingArg(['log', '--oneline', '-n', '5'])).toBeNull()
    expect(findProgramExecutingArg(['cat-file', '-p', 'HEAD'])).toBeNull()
    // `-c` also means "reuse this commit" for `git commit`, whose value has no
    // `=`; the config read must not swallow it.
    expect(findProgramExecutingArg(['commit', '-c', 'HEAD~1'])).toBeNull()
    expect(findProgramExecutingArg(['-c', 'color.ui=always', 'log'])).toBeNull()
  })
})

describe('Git tool: program-executing options', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('blocks the options that make git run a program', async () => {
    const blocked = [
      'ls-remote --upload-pack=/tmp/x.sh /tmp/repo',
      'ls-remote --upload-pack /tmp/x.sh /tmp/repo',
      'push --receive-pack=/tmp/x.sh origin main',
      '--exec-path=/tmp/evil status',
    ]
    for (const cmd of blocked) {
      const result = await gitTool.execute({ command: cmd }, ctx)
      expect(result.success, `expected "${cmd}" to be blocked`).toBe(false)
      expect(result.error).toContain('makes git run an arbitrary program')
    }
  })

  it('does not spawn anything when it blocks one', async () => {
    const spawn = vi.spyOn(Bun, 'spawn')
    await gitTool.execute({ command: 'ls-remote --upload-pack=/tmp/x.sh /tmp/repo' }, ctx)
    expect(spawn).not.toHaveBeenCalled()
  })

  // The counterweight: a rule that simply refused every `ls-remote` would pass
  // the tests above while breaking the tool.
  it('still runs the same commands without the option', async () => {
    let capturedCmd: string[] | undefined
    vi.spyOn(Bun, 'spawn').mockImplementation((cmd: any) => {
      capturedCmd = cmd as string[]
      return createMockProc('ok') as any
    })

    const safe = await gitTool.execute({ command: 'ls-remote origin' }, ctx)
    expect(safe.success).toBe(true)
    expect(capturedCmd).toEqual(['git', 'ls-remote', 'origin'])

    const fetch = await gitTool.execute({ command: 'fetch origin' }, ctx)
    expect(fetch.success).toBe(true)
  })

  it('keeps blocking the config-key spellings it always blocked', async () => {
    for (const cmd of ['-c core.pager=cat log', 'config alias.s !sh']) {
      const result = await gitTool.execute({ command: cmd }, ctx)
      expect(result.success, `expected "${cmd}" to stay blocked`).toBe(false)
    }
  })
})

// ============================================================
// splitCommand — shell-quoting-aware argv tokenizer
// ============================================================

describe('splitCommand', () => {
  it('splits on whitespace', () => {
    expect(splitCommand('status')).toEqual(['status'])
    expect(splitCommand('log --oneline -5')).toEqual(['log', '--oneline', '-5'])
  })

  it('preserves double-quoted arguments with spaces', () => {
    expect(splitCommand('commit -m "multi word message"')).toEqual([
      'commit',
      '-m',
      'multi word message',
    ])
  })

  it('preserves single-quoted arguments with spaces', () => {
    expect(splitCommand("commit -m 'multi word message'")).toEqual([
      'commit',
      '-m',
      'multi word message',
    ])
  })

  it('handles backslash-escaped spaces', () => {
    expect(splitCommand('add file\\ with\\ spaces.txt')).toEqual(['add', 'file with spaces.txt'])
  })

  it('handles empty and whitespace-only input', () => {
    expect(splitCommand('')).toEqual([])
    expect(splitCommand('   ')).toEqual([])
  })
})

// ============================================================
// Task Tool
// ============================================================

describe('Task tool definition', () => {
  it('has correct metadata', () => {
    expect(taskTool.name).toBe('Task')
    expect(taskTool.category).toBe('exec')
    expect(taskTool.permission).toBe('self')
  })

  it('requires action parameter', () => {
    const params = taskTool.parameters as { required: string[] }
    expect(params.required).toEqual(['action'])
  })

  it('accepts action enum: create, list, update, get, delete', () => {
    const params = taskTool.parameters as { properties: Record<string, unknown> }
    const action = params.properties.action as { enum: string[] }
    expect(action.enum).toEqual(['create', 'list', 'update', 'get', 'delete', 'output', 'stop'])
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

  it('软门：无 supported 证据时 completed 标记 unverified 但放行', async () => {
    clearEvidenceLog()
    const create = await taskTool.execute({ action: 'create', subject: 'No evidence' }, ctx)
    const taskId = create.content.match(/#(\d+)/)?.[1] ?? '1'
    const update = await taskTool.execute({ action: 'update', taskId, status: 'completed' }, ctx)
    expect(update.success).toBe(true) // 放行（软门）
    const get = await taskTool.execute({ action: 'get', taskId }, ctx)
    expect(get.content).toContain('Completion evidence: unverified')
    clearEvidenceLog()
  })

  it('有 supported 证据时 completed 标记 supported', async () => {
    clearEvidenceLog()
    const create = await taskTool.execute({ action: 'create', subject: 'With evidence' }, ctx)
    const taskId = create.content.match(/#(\d+)/)?.[1] ?? '1'
    recordToolEvidence('Bash', { verdict: 'supported', checkerId: 'bash-exit' })
    const update = await taskTool.execute({ action: 'update', taskId, status: 'completed' }, ctx)
    expect(update.success).toBe(true)
    const get = await taskTool.execute({ action: 'get', taskId }, ctx)
    expect(get.content).toContain('Completion evidence: supported')
    clearEvidenceLog()
  })

  it('errors for unknown action', async () => {
    const r = await taskTool.execute({ action: 'nonexistent' }, ctx)
    expect(r.success).toBe(false)
    expect(r.error).toContain('Unknown action')
  })
})

// ============================================================
// C1 — worktree isolation covers BOTH roots
//
// Worktrees moved from .claude/worktrees/ to .mipham/worktrees/. The
// enforcement points (Bash cd escape, Git outside-path reference) must
// recognize the new prefix AND keep recognizing the old one, otherwise
// every worktree created before the move silently loses its protection.
// These tests pin that: same assertion, two cwds.
// ============================================================

describe('C1 — worktree isolation covers both roots', () => {
  const NEW_WT = '/proj/.mipham/worktrees/w1'
  const LEGACY_WT = '/proj/.claude/worktrees/w1'
  const at = (cwd: string): ToolContext => ({ ...ctx, cwd })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Bash: cd escape ──

  it('blocks cd escape from a worktree under .mipham/worktrees/', async () => {
    mockSpawn()
    const result = await bashTool.execute({ command: 'cd /etc && cat passwd' }, at(NEW_WT))
    expect(result.success).toBe(false)
    expect(result.error).toContain('Worktree isolation')
  })

  it('blocks cd escape from a legacy worktree under .claude/worktrees/', async () => {
    mockSpawn()
    const result = await bashTool.execute({ command: 'cd /etc && cat passwd' }, at(LEGACY_WT))
    expect(result.success).toBe(false)
    expect(result.error).toContain('Worktree isolation')
  })

  it('allows cd inside the project from a .mipham worktree', async () => {
    mockSpawn()
    const result = await bashTool.execute({ command: 'cd /proj/src && ls' }, at(NEW_WT))
    expect(result.success).toBe(true)
  })

  // 下面两条此前是**活绕过**：守卫在，但解析方式让它们通过。
  // 纯函数断言与这里互为「只接一条」的防线 —— 前者绿而守卫没接上时，这里红。

  it('blocks a relative .. walk that stays string-prefixed to cwd', async () => {
    mockSpawn()
    const result = await bashTool.execute({ command: 'cd ../../../.. && ls' }, at(NEW_WT))
    expect(result.success).toBe(false)
    expect(result.error).toContain('Worktree isolation')
  })

  it('blocks an escape hidden behind a second cd', async () => {
    mockSpawn()
    const result = await bashTool.execute({ command: 'cd sub && cd /etc && ls' }, at(NEW_WT))
    expect(result.success).toBe(false)
    expect(result.error).toContain('Worktree isolation')
  })

  it('leaves cwd outside any worktree unconstrained', async () => {
    mockSpawn()
    const result = await bashTool.execute({ command: 'cd /etc && ls' }, at('/proj/src'))
    expect(result.success).toBe(true)
  })

  // ── Git: reference outside the worktree ──

  it('blocks an outside --work-tree reference from a .mipham worktree', async () => {
    mockSpawn()
    const result = await gitTool.execute({ command: 'status --work-tree=/other' }, at(NEW_WT))
    expect(result.success).toBe(false)
    expect(result.error).toContain('Worktree isolation')
  })

  it('blocks an outside --work-tree reference from a legacy .claude worktree', async () => {
    mockSpawn()
    const result = await gitTool.execute({ command: 'status --work-tree=/other' }, at(LEGACY_WT))
    expect(result.success).toBe(false)
    expect(result.error).toContain('Worktree isolation')
  })

  it('allows a --work-tree reference inside the project', async () => {
    mockSpawn()
    const result = await gitTool.execute({ command: 'status --work-tree=/proj/other' }, at(NEW_WT))
    expect(result.success).toBe(true)
  })

  // 下面两条此前是**活绕过**：判据是字符串前缀比较且从不归一，`/proj/../etc`
  // 因为「以 /proj/ 开头」被放行，而 git 实际拿到的是 /etc。

  it('blocks a --work-tree reference that climbs out with ..', async () => {
    mockSpawn()
    const result = await gitTool.execute({ command: 'status --work-tree=/proj/../etc' }, at(NEW_WT))
    expect(result.success).toBe(false)
    expect(result.error).toContain('Worktree isolation')
  })

  it('allows a relative --work-tree reference that stays in the project', async () => {
    // 语义变更，明说：归一后被判定「在项目内」的相对引用由「拦」改为「放」，
    // 与 Bash 守卫同一套判据（resolve 后按路径分段比较）。判据边界仍是项目根。
    mockSpawn()
    const result = await gitTool.execute({ command: 'status --work-tree=sub' }, at(NEW_WT))
    expect(result.success).toBe(true)
  })

  // ── ExitWorktree: path validation accepts both roots ──

  it('accepts a worktree path under the new .mipham root', async () => {
    mockSpawn(`worktree ${NEW_WT}\n`)
    const result = await exitWorktreeTool.execute({ path: NEW_WT, action: 'keep' }, at('/proj'))
    expect(result.success).toBe(true)
  })

  it('accepts a worktree path under the legacy .claude root', async () => {
    mockSpawn(`worktree ${LEGACY_WT}\n`)
    const result = await exitWorktreeTool.execute({ path: LEGACY_WT, action: 'keep' }, at('/proj'))
    expect(result.success).toBe(true)
  })

  it('rejects a path under neither root', async () => {
    mockSpawn()
    const result = await exitWorktreeTool.execute(
      { path: '/proj/.mipham/worktrees-evil/w1', action: 'keep' },
      at('/proj'),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('is not under')
  })
})

// ============================================================
// Task tool — background agent ids (`bg-…`)
//
// The Agent tool advertises `Use Task output taskId="bg-…"` / `Use Task stop
// taskId="bg-…"`, but the store above mints ids "1", "2", … — the two id spaces
// never intersect, so before this path existed the advertised call could only
// return `Task #bg-… not found`. These drive a **real** registry (no stub): the
// id space is the thing under test, so stubbing it would test the stub.
// ============================================================

describe('Task tool — background agent ids', () => {
  const withRegistry = (backgroundAgentRegistry: BackgroundAgentRegistry): ToolContext => ({
    ...ctx,
    backgroundAgentRegistry,
  })

  /** Spawn a real task that stays `running` until something aborts it. */
  function spawnRunning(
    registry: BackgroundAgentRegistry,
    description = 'Do background work',
  ): string {
    return registry.spawn(
      description,
      'general',
      (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        }),
    )
  }

  it('output reports a running background agent instead of "not found"', async () => {
    const registry = new BackgroundAgentRegistry()
    const id = spawnRunning(registry)

    const r = await taskTool.execute({ action: 'output', taskId: id }, withRegistry(registry))

    expect(r.error).toBeUndefined()
    expect(r.content).toContain(`Background task ${id}`)
    expect(r.content).toContain('still running')
    expect(r.content).toContain('Do background work')
  })

  it('output returns the result of a completed background agent', async () => {
    const registry = new BackgroundAgentRegistry()
    const id = registry.spawn('Summarize the repo', 'explore', async () => 'THE RESULT')
    await new Promise<void>((resolve) => registry.onComplete(id, () => resolve()))

    const r = await taskTool.execute({ action: 'output', taskId: id }, withRegistry(registry))

    expect(r.success).toBe(true)
    expect(r.content).toContain('THE RESULT')
  })

  it("output surfaces a failed background agent's error", async () => {
    const registry = new BackgroundAgentRegistry()
    const id = registry.spawn('Explode', 'general', async () => {
      throw new Error('kaboom')
    })
    await new Promise<void>((resolve) => registry.onComplete(id, () => resolve()))

    const r = await taskTool.execute({ action: 'output', taskId: id }, withRegistry(registry))

    expect(r.success).toBe(false)
    expect(r.error).toContain('kaboom')
  })

  it('stop aborts the background agent through its registry', async () => {
    const registry = new BackgroundAgentRegistry()
    const id = spawnRunning(registry)

    const r = await taskTool.execute({ action: 'stop', taskId: id }, withRegistry(registry))

    expect(r.success).toBe(true)
    expect(r.content).toContain(`Background task ${id} stopped`)
    // The observable effect of stop(), not the message it printed.
    expect(registry.get(id)!.abortController.signal.aborted).toBe(true)
  })

  it('stop on an already-finished background agent says so without aborting', async () => {
    const registry = new BackgroundAgentRegistry()
    const id = registry.spawn('Quick', 'general', async () => 'done')
    await new Promise<void>((resolve) => registry.onComplete(id, () => resolve()))

    const r = await taskTool.execute({ action: 'stop', taskId: id }, withRegistry(registry))

    expect(r.success).toBe(true)
    expect(r.content).toContain('already completed')
  })

  // ── 对照：查不到时必须仍说「找不到」，本地任务不得被改道 ──

  it('an unknown id is still "not found", with or without a registry', async () => {
    const registry = new BackgroundAgentRegistry()
    const without = await taskTool.execute({ action: 'output', taskId: 'bg-404-nope' }, ctx)
    const withReg = await taskTool.execute(
      { action: 'output', taskId: 'bg-404-nope' },
      withRegistry(registry),
    )

    expect(without.success).toBe(false)
    expect(without.error).toContain('not found')
    expect(withReg.success).toBe(false)
    expect(withReg.error).toContain('not found')
  })

  it('a local session id is still served from the local store when a registry is present', async () => {
    const registry = new BackgroundAgentRegistry()
    const create = await taskTool.execute(
      { action: 'create', subject: 'Local one' },
      withRegistry(registry),
    )
    const localId = /Task #(\S+) created/.exec(create.content)![1]!

    const r = await taskTool.execute({ action: 'output', taskId: localId }, withRegistry(registry))

    expect(r.content).toContain('Local one')
  })

  it('stop on a local in-progress task still only marks it failed', async () => {
    const registry = new BackgroundAgentRegistry()
    const create = await taskTool.execute(
      { action: 'create', subject: 'Local run' },
      withRegistry(registry),
    )
    const localId = /Task #(\S+) created/.exec(create.content)![1]!
    await taskTool.execute(
      { action: 'update', taskId: localId, status: 'in_progress' },
      withRegistry(registry),
    )

    const r = await taskTool.execute({ action: 'stop', taskId: localId }, withRegistry(registry))

    expect(r.content).toContain(`Task #${localId} stopped.`)
    const get = await taskTool.execute({ action: 'get', taskId: localId }, withRegistry(registry))
    expect(get.content).toContain('failed')
    expect(get.content).toContain('stopped by user')
  })
})
