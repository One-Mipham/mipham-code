import { resolve } from 'node:path'
import type { ToolDefinition } from '../../shared/index.ts'
import { findWorktreeMarker } from '../../core/paths.ts'
import { isWithin } from '../../security/path.ts'

/** Generous enough for a clone or fetch, short enough to bound a hung git. */
const GIT_TIMEOUT_MS = 120_000

// P0-4 (v2.1.222 alignment): Regex-based word-boundary patterns replace
// fragile substring matching. Each pattern describes what it blocks.
export const DANGEROUS_GIT_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
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
  // Remote manipulation (repo redirection / exfiltration)
  { pattern: /\bremote\s+(?:add|set-url|rename)\b/, description: 'remote add/set-url/rename' },
  // History rewrite
  { pattern: /\bcommit\s+.*--amend\b/, description: 'commit --amend (history rewrite)' },
  {
    pattern: /\bcommit\s+.*(?:--no-verify|-n)\b/,
    description: 'commit --no-verify/-n (hook bypass)',
  },
  // Command-execution vectors via git config
  {
    pattern: /(?:-c\s+|--config[=\s]|config\s+)core\.(?:sshCommand|pager|askpass|editor)/,
    description: 'git core.* command execution (sshCommand/pager/askpass/editor)',
  },
  {
    pattern: /(?:-c\s+|--config[=\s]|config\s+)(?:alias\.|credential\.helper)/,
    description: 'git alias/credential.helper command execution',
  },
]

/**
 * Check if the command references paths outside the current working directory
 * when operating in a worktree context.
 */
function isOutsideWorktree(command: string, cwd: string): string | null {
  // 标记取自 core/paths.ts：新目录与历史 .claude/worktrees/ 都认，隔离度只增不减。
  const marker = findWorktreeMarker(cwd)
  if (!marker) return null

  // Extract the project root (everything before the worktree marker)
  const worktreeRoot = marker.root

  // Detect git commands that reference the main checkout path.
  // NOTE: no `\b` before the leading `-` — `\b` needs a word/non-word
  // transition and `-` is itself a non-word char, so `\b--work-tree=` never
  // matched anything and this whole check was silently dead. `-C` needs an
  // explicit boundary because without one it would match inside a path.
  const mainCheckoutPaths = [
    /--work-tree=([^\s]+)/g,
    /--git-dir=([^\s]+)/g,
    /(?:^|\s)-C\s+([^\s]+)/g,
  ]

  for (const pathPattern of mainCheckoutPaths) {
    let match: RegExpExecArray | null
    while ((match = pathPattern.exec(command)) !== null) {
      const refPath = match[1]!
      // 归一后按**路径分段**判归属，不用字符串前缀：此前 `refPath.startsWith(cwd)`
      // 从不解析 `..`，`--work-tree=/proj/../etc` 因为「以 /proj/ 开头」被放行，
      // 而 git 拿到的是 /etc。判据与 Bash 守卫（resolveWorktreeEscape）同一套。
      const resolved = resolve(cwd, refPath)
      if (!isWithin(resolved, cwd) && !isWithin(resolved, worktreeRoot)) {
        return `Git command references path outside worktree: ${refPath}`
      }
    }
  }

  return null
}

/**
 * Git options whose value is a program git will execute. The regex list above
 * covers command execution reached through config keys; these are the ones it
 * does not name at all, and each was confirmed to run an arbitrary local
 * program: `ls-remote --upload-pack=/tmp/x.sh <path>`, `push --receive-pack=…`,
 * and `--exec-path=<dir>` followed by a planted `<dir>/git-<subcommand>`.
 */
const PROGRAM_EXECUTING_OPTIONS = ['--upload-pack', '--receive-pack', '--exec-path']

/** Config keys whose value git runs as a program. */
const PROGRAM_EXECUTING_CONFIG_KEY =
  /^(?:core\.(?:sshCommand|pager|askpass|editor)|alias\.|credential\.helper)/i

/**
 * Find an argv entry that makes git execute a program the caller named.
 *
 * This runs on the parsed argv rather than the raw command string. The regex
 * list above is organised by *spelling*, so it has to anticipate every way the
 * text can be written — `" -c " + "core.pager=…" ` written with quotes between
 * the two halves never matches it, yet git receives the same two tokens. argv
 * is what git actually gets, so it has no such gap.
 */
export function findProgramExecutingArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!

    for (const opt of PROGRAM_EXECUTING_OPTIONS) {
      // `--upload-pack=<exec>` and `--upload-pack <exec>` are both accepted.
      if (arg === opt) return `${arg} ${argv[i + 1] ?? ''}`
      if (arg.startsWith(`${opt}=`)) return arg
    }

    // `-c<key>=<value>` / `--config=<key>=<value>`. `--config=…` is checked
    // first so `/^-c[^-]/` cannot swallow it.
    const attached = arg.startsWith('--config=')
      ? arg.slice('--config='.length)
      : /^-c[^-]/.test(arg)
        ? arg.slice(2)
        : null
    if (attached !== null && PROGRAM_EXECUTING_CONFIG_KEY.test(attached)) return arg

    // `-c <key>=<value>` / `--config <key>=<value>`. A bare `-c` also means
    // "reuse this commit" for `git commit`, but that value never contains `=`,
    // so the config read cannot swallow it.
    if ((arg === '-c' || arg === '--config') && i + 1 < argv.length) {
      const next = argv[i + 1]!
      if (next.includes('=') && PROGRAM_EXECUTING_CONFIG_KEY.test(next)) {
        return `${arg} ${next}`
      }
    }
  }
  return null
}

/**
 * Split a git command string into argv tokens, honoring shell-style quoting
 * (single quotes, double quotes, and backslash escapes). Unlike a naive
 * `split(/\s+/)`, this keeps `-m "multi word message"` as a single argument
 * instead of splitting it into separate tokens.
 */
export function splitCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!

    if (inSingle) {
      if (ch === "'") inSingle = false
      else current += ch
      continue
    }

    if (inDouble) {
      if (ch === '"') inDouble = false
      else if (ch === '\\' && i + 1 < command.length && '$`"\\'.includes(command[i + 1]!)) {
        current += command[++i]!
      } else {
        current += ch
      }
      continue
    }

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (current !== '') {
        tokens.push(current)
        current = ''
      }
      continue
    }

    if (ch === "'") {
      inSingle = true
    } else if (ch === '"') {
      inDouble = true
    } else if (ch === '\\' && i + 1 < command.length) {
      current += command[++i]!
    } else {
      current += ch
    }
  }

  if (current !== '') tokens.push(current)
  return tokens
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

    // Git runs without an approval prompt (`permission: 'auto'`), so an option
    // that names a program to execute is a code-execution path Bash would have
    // had to ask for. Checked on argv, which is what git is handed below.
    const argv = splitCommand(command)
    const execArg = findProgramExecutingArg(argv)
    if (execArg) {
      return {
        success: false,
        content: '',
        error: `Dangerous git option blocked: "${execArg}" makes git run an arbitrary program. Run manually if intended.`,
      }
    }

    try {
      const proc = Bun.spawn(['git', ...argv], {
        cwd: ctx.cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      // Bounded like Bash: a git command that blocks on a pager, a credential
      // prompt, or an unreachable remote would otherwise hang the turn forever.
      const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS)
      const output = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      clearTimeout(timer)

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
