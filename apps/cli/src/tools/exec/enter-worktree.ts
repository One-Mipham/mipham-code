import type { ToolDefinition } from '../../shared/index.ts'
import { worktreeRoot } from '../../core/paths.ts'

export const enterWorktreeTool: ToolDefinition = {
  name: 'EnterWorktree',
  description:
    'Create an isolated git worktree for parallel development. ' +
    'Creates a new worktree at .mipham/worktrees/<name> on its own branch. ' +
    'Use this when you need to work on a separate task without affecting the main workspace. ' +
    'Pair with ExitWorktree to clean up when done.',
  category: 'exec',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Name for the new worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total.',
      },
      baseRef: {
        type: 'string',
        description:
          'Base branch or ref to create from. Default: the current HEAD. Use "origin/main" or a branch name to start from a specific point.',
      },
    },
    required: ['name'],
  },
  async execute(params, ctx) {
    const name = params.name as string
    const baseRef = (params.baseRef as string) || 'HEAD'

    // Validate name
    if (name.length > 64) {
      return {
        success: false,
        content: '',
        error: 'Worktree name must be 64 characters or fewer.',
      }
    }
    if (!/^[a-zA-Z0-9._/-]+$/.test(name)) {
      return {
        success: false,
        content: '',
        error:
          'Worktree name may only contain letters, digits, dots, underscores, dashes, and slashes.',
      }
    }
    // Prevent path traversal via .. segments
    if (name.includes('..')) {
      return {
        success: false,
        content: '',
        error: 'Worktree name may not contain ".." path segments.',
      }
    }

    const cwd = ctx.cwd
    const { resolve } = await import('node:path')
    const worktreePath = resolve(worktreeRoot(cwd), name)
    const allowedPrefix = resolve(worktreeRoot(cwd))

    // Defense-in-depth: verify resolved path stays within the worktree root
    if (
      !worktreePath.startsWith(allowedPrefix + '/') &&
      worktreePath !== allowedPrefix.slice(0, -1)
    ) {
      return {
        success: false,
        content: '',
        error: 'Worktree path must be within .mipham/worktrees/.',
      }
    }

    try {
      // Validate we're in a git repo
      const gitCheck = Bun.spawn(['git', 'rev-parse', '--git-dir'], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const gitCheckExit = await gitCheck.exited
      if (gitCheckExit !== 0) {
        return {
          success: false,
          content: '',
          error: 'Not in a git repository. EnterWorktree requires a git working directory.',
        }
      }

      // Check if worktree already exists
      const checkProc = Bun.spawn(['git', 'worktree', 'list', '--porcelain'], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const existingWorktrees = await new Response(checkProc.stdout).text()
      if (existingWorktrees.includes(worktreePath)) {
        return {
          success: true,
          content:
            `── Worktree Already Exists ──\n\n` +
            `Path:    ${worktreePath}\n` +
            `Name:    ${name}\n\n` +
            `This worktree already exists. To use it:\n` +
            `  cd ${worktreePath}\n\n` +
            `To remove it, use ExitWorktree.`,
        }
      }

      // Determine base ref
      let resolvedBaseRef = baseRef
      if (baseRef === 'HEAD') {
        try {
          const branchProc = Bun.spawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd,
            stdout: 'pipe',
            stderr: 'pipe',
          })
          const branch = (await new Response(branchProc.stdout).text()).trim()
          resolvedBaseRef = branch || 'HEAD'
        } catch {
          resolvedBaseRef = 'HEAD'
        }
      }

      // Create worktree with new branch
      const branchName = `worktree/${name}`
      // `--` ends git's option parsing. `baseRef` comes from the model and is
      // otherwise unvalidated, so without it a ref spelled `--force` is read as
      // an *option*: measured on this machine, `git worktree add -b b <path>
      // --force` succeeds, while a bogus ref in that same slot is `fatal:
      // invalid reference`. After `--` git reads it as a ref and rejects
      // nonsense, which is what a bad base ref should do.
      const proc = Bun.spawn(
        ['git', 'worktree', 'add', '-b', branchName, worktreePath, '--', resolvedBaseRef],
        { cwd, stdout: 'pipe', stderr: 'pipe' },
      )
      const _stdout = await new Response(proc.stdout).text()
      const exitCode = await proc.exited

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        return {
          success: false,
          content: '',
          error: `Failed to create worktree: ${stderr.slice(0, 1000)}`,
        }
      }

      return {
        success: true,
        content:
          `── Worktree Created ──\n\n` +
          `Path:      ${worktreePath}\n` +
          `Branch:    ${branchName}\n` +
          `Base:      ${resolvedBaseRef}\n\n` +
          `The worktree is ready. To switch to it:\n` +
          `  cd ${worktreePath}\n\n` +
          `Work in the worktree is isolated — changes on "${branchName}" won't affect your main branch.\n` +
          `When done, use ExitWorktree to clean up.`,
      }
    } catch (err) {
      return {
        success: false,
        content: '',
        error: `Worktree creation failed: ${String(err)}`,
      }
    }
  },
}
