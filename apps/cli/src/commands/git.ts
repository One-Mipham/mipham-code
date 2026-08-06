/**
 * Mipham Code — Git & GitHub Slash Commands
 *
 * Extracted from ui/commands.ts (2026-08-06).
 * Handlers for: /commit, /push, /pr, /issue
 */
import type { CommandHandler } from '../ui/commands.js'
import { stripIndent } from '../ui/strip-indent.js'

export { commitCmd, pushCmd, prCmd, issueCmd }


const commitCmd: CommandHandler = async () => {
  try {
    const { execSync } = await import('node:child_process')
    const diff = execSync('git diff --cached --stat', { encoding: 'utf-8', timeout: 5000 }).trim()
    const unstaged = execSync('git diff --name-only', { encoding: 'utf-8', timeout: 5000 }).trim()

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
    const { execSync } = await import('node:child_process')
    const branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim()
    const ahead = execSync(`git rev-list --count origin/${branch}..HEAD 2>/dev/null || echo 0`, {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim()

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
    const { execSync } = await import('node:child_process')
    const branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim()
    const mainBranch =
      execSync('git remote show origin 2>/dev/null | grep "HEAD branch" | cut -d: -f2', {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim() || 'main'

    const diff = execSync(
      `git diff --stat origin/${mainBranch}...HEAD 2>/dev/null || git diff --stat ${mainBranch}...HEAD 2>/dev/null || echo ""`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim()

    const commits = execSync(
      `git log --oneline origin/${mainBranch}..HEAD 2>/dev/null || git log --oneline ${mainBranch}..HEAD 2>/dev/null || echo ""`,
      { encoding: 'utf-8', timeout: 5000 },
    ).trim()

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
