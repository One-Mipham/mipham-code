import { DEFAULT_CREDENTIAL_MASKING_CONFIG } from '../config/defaults'
import { stripEnv } from '../core/credential-masker/env-filter'

/**
 * Environment for processes **this program runs on its own behalf** (creating a
 * worktree, reading the branch, searching with ripgrep, …) — as opposed to
 * commands the model asked to run in the user's shell.
 *
 * Two things are true of these children:
 *
 * 1. **They never need the user's credentials.** A provider API key or token in
 *    their environment is not used by them — but it *is* readable by whatever
 *    they run: a git credential helper, a `pre-commit` hook, a `.git/config`
 *    `filter.*` driver. The keys are ours to keep, so they are stripped rather
 *    than handed down (the model's shell keeps the masking contract instead —
 *    see `filterEnv`).
 * 2. **They derive no correctness from replace refs.** `GIT_NO_REPLACE_OBJECTS=1`
 *    makes git ignore `refs/replace/*`. A replace ref rewrites what a commit
 *    *appears to be*: `git replace <a> <b>` makes every reader of `<a>` see
 *    `<b>`'s tree, so a checkout / `worktree add` produced from that view
 *    contains different files than the real object graph. These are local refs
 *    that any process in the repository can write, and this program derives no
 *    correctness from replaying them — the isolation boundary (`enter-worktree`,
 *    workflow agents, `/fork`, the CRSI sandbox) has to be built from true
 *    history. `git` itself still accepts the env var as an escape hatch, so
 *    nothing here breaks a repository that genuinely relies on replacements in
 *    a user's shell.
 */
export function internalProcessEnv(): NodeJS.ProcessEnv {
  return stripEnv(
    process.env as Record<string, string | undefined>,
    DEFAULT_CREDENTIAL_MASKING_CONFIG,
  )
}

/**
 * `internalProcessEnv()` plus the git-specific replace-ref guard. Kept as a
 * separate name because the reason for the guard is git's, not the credentials'.
 */
export function internalGitEnv(): NodeJS.ProcessEnv {
  return { ...internalProcessEnv(), GIT_NO_REPLACE_OBJECTS: '1' }
}
