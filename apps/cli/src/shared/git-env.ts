/**
 * Environment for git commands **this program runs on its own behalf** (creating
 * a worktree, reading the branch, …) — as opposed to commands the model asked to
 * run in the user's shell.
 *
 * `GIT_NO_REPLACE_OBJECTS=1` makes git ignore `refs/replace/*`. A replace ref
 * rewrites what a commit *appears to be*: `git replace <a> <b>` makes every
 * reader of `<a>` see `<b>`'s tree, so a checkout / `worktree add` produced from
 * that view contains different files than the real object graph. These are local
 * refs that any process in the repository can write, and this program derives no
 * correctness from replaying them — the isolation boundary (`enter-worktree`,
 * workflow agents, `/fork`, the CRSI sandbox) has to be built from true history.
 * `git` itself still accepts the env var as an escape hatch, so nothing here
 * breaks a repository that genuinely relies on replacements in a user's shell.
 */
export function internalGitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' }
}
