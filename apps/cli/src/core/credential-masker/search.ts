import type { CredentialMaskingConfig } from '../../shared/index.ts'
import { matchCredentialFile } from './matcher'
import { CREDENTIAL_SENTINEL } from './types'

/**
 * Mask grep/search output: any match line that belongs to a credential file
 * (e.g. `.env`, `.aws/credentials`) has its content replaced with the
 * credential sentinel, so Grep can't leak secrets that Read would mask.
 *
 * `format` disambiguates the two shapes the Grep tool emits — each invocation
 * produces exactly one, so there is no cross-format ambiguity to guess at:
 *   - 'heading'  (ripgrep `--heading`): file path on its own line, then `N:content` lines
 *   - 'filename' (plain grep `-rn`):    `path:N:content` on a single line
 *
 * NOTE: the sensitive file's *path* stays visible — only its match content is
 * masked. That's intentional for grep (a targeted search where the model already
 * named the path); the secret is the content, not the location. Contrast
 * `maskGlobOutput`, which hides the path entirely (enumeration's leak is existence).
 */
export function maskSearchOutput(
  stdout: string,
  config?: CredentialMaskingConfig,
  format: 'heading' | 'filename' = 'heading',
): string {
  if (!config?.enabled) return stdout
  const out: string[] = []
  let currentMasked = false

  for (const line of stdout.split('\n')) {
    if (format === 'filename') {
      const m = line.match(/^(.+?):(\d+):(.*)$/)
      if (m) {
        out.push(
          matchCredentialFile(m[1]!, config) ? `${m[1]}:${m[2]}:${CREDENTIAL_SENTINEL}` : line,
        )
      } else {
        out.push(line)
      }
      continue
    }

    // 'heading' format: match lines are `N:content`; everything non-empty else is a file heading.
    const m = line.match(/^(\d+):(.*)$/)
    if (m) {
      out.push(currentMasked ? `${m[1]}:${CREDENTIAL_SENTINEL}` : line)
      continue
    }
    if (line.trim() === '') {
      out.push(line) // blank separator — pass through, keep current file
      continue
    }
    currentMasked = !!matchCredentialFile(line, config)
    out.push(line)
  }

  return out.join('\n')
}

/**
 * Mask a glob file listing: sensitive file paths are replaced with the
 * credential sentinel so file enumeration can't reveal their existence.
 *
 * NOTE: unlike `maskSearchOutput` (which keeps the searched path visible and
 * masks only content), glob hides the whole path — here the leak is the file's
 * *existence*, not its content.
 */
export function maskGlobOutput(paths: string, config?: CredentialMaskingConfig): string {
  if (!config?.enabled) return paths
  return paths
    .split('\n')
    .map((p) => (matchCredentialFile(p, config) ? CREDENTIAL_SENTINEL : p))
    .join('\n')
}
