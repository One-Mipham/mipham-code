/**
 * Mipham Code — Git & GitHub Slash Commands
 *
 * Extracted from ui/commands.ts (2026-08-06).
 * Handlers for: /commit, /push, /pr, /issue
 */
import type { CommandHandler } from '../ui/commands.js'

export { commitCmd, pushCmd, prCmd, issueCmd }

/**
 * Run a git command asynchronously — avoids blocking the TUI event loop.
 *
 * `LC_ALL=C` is load-bearing for the callers that parse output: `git remote show
 * origin` prints `HEAD branch:` / `HEAD 分支：` depending on the locale, and the
 * English regex then quietly falls back to `main` on a machine whose git speaks
 * Chinese. Forcing the C locale makes the text we match against fixed.
 */
async function git(args: string[], timeoutMs = 5000): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  })
  const exitCode = await Promise.race([
    proc.exited,
    new Promise<number>((resolve) => setTimeout(() => resolve(143), timeoutMs)),
  ])
  if (exitCode === 143) {
    proc.kill()
    return ''
  }
  const stdout = await new Response(proc.stdout).text()
  return exitCode === 0 ? stdout.trim() : ''
}

/** Diffs can be arbitrarily large; the prompt carries a bounded prefix. */
const MAX_PROMPT_DIFF = 12_000

function promptWithDiff(intro: string, diff: string): string {
  const body =
    diff.length > MAX_PROMPT_DIFF ? `${diff.slice(0, MAX_PROMPT_DIFF)}\n… (truncated)` : diff
  return `${intro}\n\n${body}`
}

const commitCmd: CommandHandler = async () => {
  try {
    const diff = await git(['diff', '--cached', '--stat'])
    const unstaged = await git(['diff', '--name-only'])

    if (!diff) {
      let msg = '── Git Commit ──\n\nNo staged changes found.\n\n'
      if (unstaged) {
        msg +=
          'Unstaged changes exist:\n' +
          unstaged
            .split('\n')
            .map((f) => '  • ' + f)
            .join('\n') +
          '\n\n'
      }
      msg += 'Run: git add <files> to stage changes first.'
      return { content: msg }
    }

    // The command says "generate a commit message", so it must actually
    // generate one. It used to print instructions to type a sentence in chat.
    const full = await git(['diff', '--cached'], 8000)
    return {
      content: [
        '── Git Commit ──',
        '',
        'Staged changes:',
        diff,
        '',
        'Drafting a Conventional Commits message from these changes.',
        'To commit: git commit -m "<the message>"',
      ].join('\n'),
      forwardToAI: promptWithDiff(
        'Write a Conventional Commits message for the staged diff below. Output only the commit message (subject ≤72 chars, then a blank line and a body if useful). Do not run git.',
        full,
      ),
    }
  } catch {
    return { content: '── Git Commit ──\n\nCould not run git. Are you in a git repository?' }
  }
}

const pushCmd: CommandHandler = async () => {
  try {
    const branch = await git(['branch', '--show-current'], 3000)
    const aheadRaw = await git(['rev-list', '--count', `origin/${branch}..HEAD`], 3000)
    const ahead = aheadRaw || '0'

    return {
      content: [
        '── Git Push ──',
        '',
        `Branch: ${branch || '(unknown)'}`,
        `Commits ahead of remote: ${ahead}`,
        '',
        ahead !== '0'
          ? `Ready to push ${ahead} commit(s). Run: git push origin ${branch}`
          : 'Nothing to push (up to date).',
        '',
        // Pushing is an outward-facing action and slash commands bypass the
        // permission layer, so this command only reports. Saying that out loud
        // is the difference between a status view and a fake "push".
        'This command only reports; it never pushes.',
      ].join('\n'),
    }
  } catch {
    return { content: '── Git Push ──\n\nCould not determine git status.' }
  }
}

const prCmd: CommandHandler = async () => {
  try {
    const branch = await git(['branch', '--show-current'], 3000)
    const mainBranchRaw = await git(['remote', 'show', 'origin'], 3000)
    const mainBranch = mainBranchRaw.match(/HEAD branch:\s*(\S+)/)?.[1] || 'main'

    const diff =
      (await git(['diff', '--stat', `origin/${mainBranch}...HEAD`], 5000)) ||
      (await git(['diff', '--stat', `${mainBranch}...HEAD`], 5000))

    const commits =
      (await git(['log', '--oneline', `origin/${mainBranch}..HEAD`], 5000)) ||
      (await git(['log', '--oneline', `${mainBranch}..HEAD`], 5000))

    const fullDiff =
      (await git(['diff', `origin/${mainBranch}...HEAD`], 8000)) ||
      (await git(['diff', `${mainBranch}...HEAD`], 8000))

    return {
      content: [
        '── Create Pull Request ──',
        '',
        `Branch: ${branch} → ${mainBranch}`,
        '',
        commits
          ? `Commits:\n${commits
              .split('\n')
              .map((c) => '  ' + c)
              .join('\n')}`
          : 'No commits ahead.',
        '',
        diff ? `Changes:\n${diff}` : '',
        '',
        'Drafting a PR title and body from these commits.',
        'To open it: gh pr create --base ' + mainBranch + ' --head ' + branch,
      ].join('\n'),
      forwardToAI: promptWithDiff(
        `Draft a pull request title and body for the branch "${branch}" targeting "${mainBranch}". Commits:\n${commits || '(none)'}\n\nOutput only the title and body. Do not run gh or create the PR.`,
        fullDiff,
      ),
    }
  } catch {
    return { content: '── Create Pull Request ──\n\nCould not determine PR context.' }
  }
}

const issueCmd: CommandHandler = async (_ctx, args) => {
  const description = args.join(' ').trim()
  if (!description) {
    return {
      content: [
        '── GitHub Issues ──',
        '',
        'Describe the issue after the command:',
        '  /issue <what went wrong and what you expected>',
        '',
        'Quick commands:',
        '  gh issue create --title "..." --body "..."',
        '  gh issue list',
      ].join('\n'),
    }
  }

  return {
    content: [
      '── GitHub Issues ──',
      '',
      'Drafting an issue from your description.',
      '',
      'To file it: gh issue create --title "..." --body "..."',
    ].join('\n'),
    forwardToAI: `Draft a GitHub issue title and body for: ${description}\n\nOutput only the title and body. Do not run gh or create the issue.`,
  }
}

// ═══════════════════════════════════════════════════════════════
// Code Quality — bridge slash commands to skills (Claude Code parity)
// ═══════════════════════════════════════════════════════════════

/** Factory for git-diff-based commands that bridge to AI skills via forwardToAI. */
