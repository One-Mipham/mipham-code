import type { ToolDefinition } from '../../shared/index.ts'

// P0-4 (v2.1.222 alignment): Regex-based word-boundary patterns replace
// fragile substring matching. Each pattern describes what it blocks.
const DANGEROUS_GIT_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  // Destructive push
  { pattern: /\bpush\s+.*--force(?:-with-lease)?\b/, description: 'push --force' },
  { pattern: /\bpush\s+.*-[fF]\b/, description: 'push -f (force)' },
  { pattern: /\bpush\s+--delete\b/, description: 'push --delete (remote branch deletion)' },
  { pattern: /\bpush\s+--mirror\b/, description: 'push --mirror' },
  // Destructive reset
  { pattern: /\breset\s+--hard\b/, description: 'reset --hard' },
  { pattern: /\breset\s+--merge\b/, description: 'reset --merge' },
  { pattern: /\breset\s+--keep\b/, description: 'reset --keep' },
  // Destructive clean
  { pattern: /\bclean\s+-[a-z]*f[a-z]*d[a-z]*\b/, description: 'clean -fd' },
  { pattern: /\bclean\s+-[a-z]*d[a-z]*f[a-z]*\b/, description: 'clean -fd' },
  { pattern: /\bclean\s+-[a-z]*x[a-z]*\b/, description: 'clean -x (remove ignored files)' },
  // Force-delete branch
  { pattern: /\bbranch\s+-D\b/, description: 'branch -D (force delete)' },
  { pattern: /\bbranch\s+--delete\s+--force\b/, description: 'branch --delete --force' },
  // Rebase (potentially destructive)
  { pattern: /\brebase\s+--onto\b/, description: 'rebase --onto' },
  // Force checkout (overwrites local changes)
  { pattern: /\bcheckout\s+.*(?:--force|-f)\b/, description: 'checkout --force' },
  // Stash manipulation
  { pattern: /\bstash\s+drop\b/, description: 'stash drop' },
  { pattern: /\bstash\s+clear\b/, description: 'stash clear' },
  // Identity spoofing via config
  { pattern: /\bconfig\s+.*user\./, description: 'config user.* (identity spoofing)' },
]

/**
 * Check if the command references paths outside the current working directory
 * when operating in a worktree context.
 */
function isOutsideWorktree(command: string, cwd: string): string | null {
  const WORKTREE_MARKER = '.claude/worktrees/'
  if (!cwd.includes(WORKTREE_MARKER)) return null

  // Extract the project root (everything before .claude/worktrees/)
  const worktreeRoot = cwd.substring(0, cwd.indexOf(WORKTREE_MARKER))

  // Detect git commands that reference the main checkout path
  const mainCheckoutPaths = [
    /\b--work-tree=([^\s]+)/g,
    /\b--git-dir=([^\s]+)/g,
    /\b-C\s+([^\s]+)/g,
  ]

  for (const pathPattern of mainCheckoutPaths) {
    let match: RegExpExecArray | null
    while ((match = pathPattern.exec(command)) !== null) {
      const refPath = match[1]!
      // If the referenced path is outside the worktree, block it
      if (!refPath.startsWith(cwd) && !refPath.startsWith(worktreeRoot + '/')) {
        return `Git command references path outside worktree: ${refPath}`
      }
    }
  }

  return null
}

export const gitTool: ToolDefinition = {
  name: 'Git',
  description: 'Execute git commands. Dangerous operations (force push, hard reset) are blocked.',
  category: 'exec',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Git subcommand + args (e.g., "status", "log --oneline")',
      },
    },
    required: ['command'],
  },
  async execute(params, ctx) {
    const command = params.command as string

    // P0-4: Regex-based word-boundary pattern matching
    for (const { pattern, description } of DANGEROUS_GIT_PATTERNS) {
      if (pattern.test(command)) {
        return {
          success: false,
          content: '',
          error: `Dangerous git command blocked: "${description}". Run manually if intended.`,
        }
      }
    }

    // P0-4: Worktree isolation — block commands referencing outside paths
    const worktreeErr = isOutsideWorktree(command, ctx.cwd)
    if (worktreeErr) {
      return {
        success: false,
        content: '',
        error: `Worktree isolation: ${worktreeErr}. Blocked for safety.`,
      }
    }

    try {
      const proc = Bun.spawn(['git', ...command.split(/\s+/)], {
        cwd: ctx.cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const output = await new Response(proc.stdout).text()
      const exitCode = await proc.exited

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        return {
          success: false,
          content: '',
          error: `Git error (exit ${exitCode}): ${stderr.slice(0, 1000)}`,
        }
      }

      return {
        success: true,
        content: output.slice(0, 50_000) || '(no output)',
      }
    } catch (err) {
      return {
        success: false,
        content: '',
        error: `Git execution failed: ${String(err)}`,
      }
    }
  },
}
