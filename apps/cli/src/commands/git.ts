/**
 * Mipham Code — Git & GitHub Slash Commands
 *
 * Extracted from ui/commands.ts (2026-08-06).
 * Handlers for: /commit, /push, /pr, /issue
 */
import type { CommandHandler } from '../ui/commands.js'

export { commitCmd, pushCmd, prCmd, issueCmd }

/** Run a git command asynchronously — avoids blocking the TUI event loop. */
async function git(args: string[], timeoutMs = 5000): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
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
      msg +=
        'Run: git add <files> to stage changes first.\nOr type: "commit these changes" for AI assistance.'
      return { content: msg }
    }

    return {
      content: [
        '── Git Commit ──',
        '',
        'Staged changes:',
        diff,
        '',
        'To generate a commit message, type: "write a commit message for these changes"',
        'To commit: git commit -m "your message"',
        '',
        'Tip: Use Conventional Commits format (feat:, fix:, chore:, docs:)',
      ].join('\n'),
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
        'Or type: "push my changes" for AI assistance.',
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
        'To create PR: type "create a pull request" for AI assistance.',
        'Or use: gh pr create --base ' + mainBranch + ' --head ' + branch,
      ].join('\n'),
    }
  } catch {
    return { content: '── Create Pull Request ──\n\nCould not determine PR context.' }
  }
}

const issueCmd: CommandHandler = async () => {
  return {
    content: [
      '── GitHub Issues ──',
      '',
      'To file an issue, type: "create a GitHub issue for [description]"',
      '',
      'Quick commands:',
      '  gh issue create --title "..." --body "..."',
      '  gh issue list',
      '',
      'Use /github-ops skill for advanced GitHub automation.',
    ].join('\n'),
  }
}

// ═══════════════════════════════════════════════════════════════
// Code Quality — bridge slash commands to skills (Claude Code parity)
// ═══════════════════════════════════════════════════════════════

/** Factory for git-diff-based commands that bridge to AI skills via forwardToAI. */
