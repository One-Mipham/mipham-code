import type { ToolDefinition } from '../../shared/index.ts'

export const exitWorktreeTool: ToolDefinition = {
  name: 'ExitWorktree',
  description:
    'Remove a git worktree created by EnterWorktree. ' +
    'Use action "remove" to delete the worktree and its branch, ' +
    'or "keep" to leave it intact on disk.',
  category: 'exec',
  permission: 'ask',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the worktree to exit. Must be under .claude/worktrees/.',
      },
      action: {
        type: 'string',
        enum: ['keep', 'remove'],
        description:
          '"keep" leaves the worktree and branch on disk. "remove" deletes both the worktree directory and its branch.',
      },
      discard_changes: {
        type: 'boolean',
        description:
          'Required true when action is "remove" and the worktree has uncommitted files or unmerged commits. The tool will refuse and list them otherwise.',
      },
    },
    required: ['path', 'action'],
  },
  async execute(params, ctx) {
    const worktreePath = params.path as string
    const action = params.action as string
    const discardChanges = params.discard_changes === true

    // Validate the path is under .claude/worktrees
    const cwd = ctx.cwd
    const { resolve } = await import('node:path')
    const resolvedPath = resolve(worktreePath)
    const allowedPrefix = resolve(`${cwd}/.claude/worktrees/`)

    if (!resolvedPath.startsWith(allowedPrefix)) {
      return {
        success: false,
        content: '',
        error:
          `Path "${worktreePath}" is not under .claude/worktrees/. ` +
          `Only worktrees created by EnterWorktree can be managed here.`,
      }
    }

    try {
      // Verify the worktree exists in git's worktree list
      const listProc = Bun.spawn(['git', 'worktree', 'list', '--porcelain'], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const listOutput = await new Response(listProc.stdout).text()

      if (!listOutput.includes(worktreePath)) {
        return {
          success: false,
          content: '',
          error:
            `Worktree not found: ${worktreePath}\n\n` +
            `This path is not in git's worktree list. It may have already been removed, ` +
            `or it was created outside of EnterWorktree.\n\n` +
            `Use "git worktree list" to see active worktrees.`,
        }
      }

      if (action === 'keep') {
        return {
          success: true,
          content:
            `── Worktree Kept ──\n\n` +
            `Path:   ${worktreePath}\n\n` +
            `The worktree and its branch are preserved on disk.\n` +
            `To remove later: ExitWorktree with action="remove".`,
        }
      }

      // action === 'remove' — check for uncommitted changes
      if (!discardChanges) {
        const statusProc = Bun.spawn(['git', '-C', worktreePath, 'status', '--porcelain'], {
          cwd,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const statusOutput = await new Response(statusProc.stdout).text()
        const changedFiles = statusOutput.trim().split('\n').filter(Boolean)

        if (changedFiles.length > 0) {
          const preview = changedFiles.slice(0, 10).join('\n')
          const extra =
            changedFiles.length > 10 ? `\n... and ${changedFiles.length - 10} more files` : ''
          return {
            success: false,
            content: '',
            error:
              `Worktree has ${changedFiles.length} uncommitted file(s):\n\n` +
              `${preview}${extra}\n\n` +
              `Set discard_changes: true to force removal and discard these changes.\n` +
              `Or commit the changes first, then retry.`,
          }
        }
      }

      // Get the branch name from worktree metadata
      let branchName = ''
      try {
        const branchProc = Bun.spawn(
          ['git', '-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
          { cwd, stdout: 'pipe', stderr: 'pipe' },
        )
        branchName = (await new Response(branchProc.stdout).text()).trim()
      } catch {
        // Branch detection is best-effort
      }

      // Remove the worktree
      const removeArgs = discardChanges
        ? ['git', 'worktree', 'remove', '--force', worktreePath]
        : ['git', 'worktree', 'remove', worktreePath]

      const removeProc = Bun.spawn(removeArgs, {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const removeExit = await removeProc.exited

      if (removeExit !== 0) {
        const stderr = await new Response(removeProc.stderr).text()
        return {
          success: false,
          content: '',
          error: `Failed to remove worktree: ${stderr.slice(0, 1000)}`,
        }
      }

      // Clean up the branch if we have its name
      if (branchName && branchName !== 'HEAD') {
        try {
          const branchProc = Bun.spawn(['git', 'branch', '-D', branchName], {
            cwd,
            stdout: 'pipe',
            stderr: 'pipe',
          })
          await branchProc.exited
          // Best-effort — branch cleanup failure is not fatal
        } catch {
          // Ignore branch cleanup failures
        }
      }

      return {
        success: true,
        content:
          `── Worktree Removed ──\n\n` +
          `Path:    ${worktreePath}\n` +
          (branchName ? `Branch:  ${branchName} (deleted)\n` : '') +
          `\nThe worktree has been removed.`,
      }
    } catch (err) {
      return {
        success: false,
        content: '',
        error: `Worktree removal failed: ${String(err)}`,
      }
    }
  },
}
