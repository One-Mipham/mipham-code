// apps/cli/src/daemon/workspace-guard.ts
//
// Guard for a caller-supplied session `cwd` on the daemon's external API.
//
// The session cwd *is* the containment boundary: `read` / `glob` / `grep` are
// confined to it by `resolveSafe`, and the blocked-path list covers system
// directories but not home directories. So a caller free to name any cwd turns
// "read inside the project" into "read anything" — the value is therefore only
// accepted from the user's trusted-workspace list, or from inside the directory
// the daemon was started in.

import { resolve, sep } from 'node:path'

/** True when `dir` is `root` itself or nested beneath it. `..` cannot escape. */
function isWithin(dir: string, root: string): boolean {
  const d = resolve(dir)
  const r = resolve(root)
  return d === r || d.startsWith(r.endsWith(sep) ? r : r + sep)
}

export function isCwdAllowed(
  cwd: string,
  isTrusted: (dir: string) => boolean,
  daemonRoot: string = process.cwd(),
): boolean {
  if (typeof cwd !== 'string' || !cwd) return false
  return isWithin(cwd, daemonRoot) || isTrusted(cwd)
}
