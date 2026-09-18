import { join } from 'node:path'
import { ARTIFACTS_DIR, MIPHAM_DIR } from '../shared/constants'

/**
 * The one place that decides *where on disk an artifact lives*.
 *
 * Three sites need to agree on this: the Artifact tool (writes the file and the
 * manifest), the ArtifactServer (serves files and builds the gallery from the
 * manifest rooted here), and `/artifact list` (reads the manifest). Each of them
 * computing the path itself is what produced the original bug: the tool wrote
 * `<cwd>/artifacts/...` while the server served `<cwd>/.mipham/artifacts/...`,
 * so the URL the tool reported was a guaranteed 404 — the two halves never met.
 *
 * Keeping them joined here means a change moves all three together; the guard
 * test asserts the *behaviour* (the reported URL resolves), not the literal.
 */
export function artifactsRoot(cwd: string): string {
  return join(cwd, MIPHAM_DIR, ARTIFACTS_DIR)
}
