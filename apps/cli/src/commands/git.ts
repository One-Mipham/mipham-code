/**
 * Mipham Code — Git & GitHub Slash Commands
 *
 * Extracted from ui/commands.ts (2026-08-06).
 * Handlers for: /commit, /push, /pr, /issue
 */
import type { CommandHandler } from '../ui/commands.js'

export { commitCmd, pushCmd, prCmd, issueCmd, shipCmd }

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
// /ship — the whole after-you-write-it loop (Claude Ship beta borrow)
// ═══════════════════════════════════════════════════════════════

export interface ShipContext {
  branch: string
  defaultBranch: string
  staged: number
  unstaged: number
  untracked: number
  ahead: string
  gh: boolean
  /** Whatever the user typed after `/ship` (e.g. `--draft`). */
  args: string
}

/**
 * The plan `/ship` hands to the model.
 *
 * Split out from the handler so the parts that are policy — never commit to the
 * default branch, never merge, report an undo command after each push — can be
 * asserted without spawning git or gh. The handler only gathers facts.
 */
export function buildShipPlan(c: ShipContext): { content: string; forwardToAI?: string } {
  if (!c.branch) {
    return {
      content:
        '── Ship ──\n\n' +
        'HEAD is detached, so there is no branch to ship. Check out a branch first, then run /ship again.',
    }
  }

  const onDefault = c.branch === c.defaultBranch
  // Only a known zero means nothing is ahead. An empty string means the
  // upstream count could not be read (no origin, or no upstream branch) — that
  // is "unknown", not "nothing", and the loop must not claim there is no work.
  const nothingToDo = c.staged === 0 && c.unstaged === 0 && c.untracked === 0 && c.ahead === '0'

  const header = [
    '── Ship ──',
    '',
    `Branch:   ${c.branch}${onDefault ? ` (the default branch)` : ''}`,
    `Changes:  ${c.staged} staged, ${c.unstaged} unstaged, ${c.untracked} untracked`,
    `Ahead:    ${c.ahead || 'unknown'} commit(s) of origin/${c.branch}`,
    `gh:       ${c.gh ? 'available' : 'not found'}`,
  ].join('\n')

  if (nothingToDo) {
    return {
      content:
        `${header}\n\n` + `Nothing to ship: no changes and nothing ahead of origin/${c.branch}.`,
    }
  }

  const forwardToAI = `Ship this branch end-to-end with the git and Bash tools. Every push and PR step is permission-checked — do not bypass that layer.

Context:
- Branch: ${c.branch}
- Default branch: ${c.defaultBranch}
- Staged / unstaged / untracked: ${c.staged} / ${c.unstaged} / ${c.untracked}
- Commits ahead of origin/${c.branch}: ${c.ahead || '0'}
- gh CLI: ${c.gh ? 'available' : 'not found'}
- User arguments: ${c.args || '(none)'}

Steps:
1. Inspect git status, the diff, and the commits ahead of ${c.defaultBranch}. Never discard the user's uncommitted work.
2. If HEAD is on ${c.defaultBranch} or detached, create a feature branch named mipham/ship-<short-slug> first. Never commit directly to ${c.defaultBranch}.
3. Stage only the intended changes and write a Conventional Commits message. If there is nothing to commit, skip this step.
4. Push the branch you are on with \`git push -u origin <branch>\` (the feature branch from step 2 if you created one).
5. If gh is available and authenticated, open a pull request with \`gh pr create --base ${c.defaultBranch} --head <branch>\`; use --draft if the user asked for one. If gh is missing or not authenticated, stop after the push and say the PR was not opened.
6. Review the PR diff with the code-review skill. Report findings with severity (important / pre_existing / nit) and file:line. If CI checks fail, read the failing logs (\`gh pr checks <n>\`, \`gh run view --log-failed\`) and fix the cause; if the branch conflicts with the base, bring the base in and resolve the conflicts carefully.
7. Fix only defects that are safe and in scope; push each round. Never force-push.
8. After every push, state what changed and the exact undo command (\`git revert <sha>\`).
9. Finish with: the PR URL, what was reviewed and fixed, and anything that needs a human decision.

Never merge, approve, or change branch protection. If a step fails, stop and name the step and its error. Do not claim a step succeeded unless its command exited 0.`

  const notes = [
    onDefault
      ? 'On the default branch — Claude will create a feature branch before committing.'
      : '',
    c.gh ? '' : 'gh not found — Claude will stop after pushing; no PR will be opened.',
  ].filter(Boolean)

  return {
    content: notes.length ? `${header}\n\n${notes.map((n) => `• ${n}`).join('\n')}` : header,
    forwardToAI,
  }
}

/** `gh --version` with a short bound; a hung binary must not hang the command. */
async function commandExists(command: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([command, '--version'], { stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) => setTimeout(() => resolve(143), 2000)),
    ])
    if (exitCode === 143) {
      proc.kill()
      return false
    }
    return exitCode === 0
  } catch {
    return false
  }
}

const shipCmd: CommandHandler = async (_ctx, args) => {
  try {
    // `git()` maps every failure to '', so "not a repository" and "detached
    // HEAD" would otherwise print the same thing. Ask explicitly.
    const inside = await git(['rev-parse', '--is-inside-work-tree'], 3000)
    if (inside !== 'true') {
      return {
        content: '── Ship ──\n\nNot a git repository. Run /ship from a repository checkout.',
      }
    }
    const branch = await git(['branch', '--show-current'], 3000)
    const remote = await git(['remote', 'show', 'origin'], 3000)
    const defaultBranch = remote.match(/HEAD branch:\s*(\S+)/)?.[1] || 'main'

    const [stagedRaw, unstagedRaw, untrackedRaw, aheadRaw] = await Promise.all([
      git(['diff', '--cached', '--name-only'], 3000),
      git(['diff', '--name-only'], 3000),
      git(['ls-files', '--others', '--exclude-standard'], 3000),
      branch ? git(['rev-list', '--count', `origin/${branch}..HEAD`], 3000) : Promise.resolve(''),
    ])

    const count = (s: string): number => s.split('\n').filter(Boolean).length

    return buildShipPlan({
      branch,
      defaultBranch,
      staged: count(stagedRaw),
      unstaged: count(unstagedRaw),
      untracked: count(untrackedRaw),
      ahead: aheadRaw || '0',
      gh: await commandExists('gh'),
      args: args.join(' ').trim(),
    })
  } catch {
    return {
      content: '── Ship ──\n\nCould not inspect the repository. Are you in a git repository?',
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Code Quality — bridge slash commands to skills (Claude Code parity)
// ═══════════════════════════════════════════════════════════════

/** Factory for git-diff-based commands that bridge to AI skills via forwardToAI. */
