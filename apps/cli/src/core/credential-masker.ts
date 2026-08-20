/**
 * Backward-compatible re-exports from the modular credential-masker/ pipeline.
 *
 * This file preserves the original API surface while delegating to the
 * modular strategy-based implementation under credential-masker/.
 */

// Re-export sentinel constant
export { CREDENTIAL_SENTINEL } from './credential-masker/types'

// Re-export core functions
export { matchCredentialFile } from './credential-masker/matcher'
export { maskContent } from './credential-masker/pipeline'
export { maskOutput } from './credential-masker/output-scrub'
export { filterEnv } from './credential-masker/env-filter'
export { maskSearchOutput, maskGlobOutput } from './credential-masker/search'

import { CREDENTIAL_SENTINEL } from './credential-masker/types'

/**
 * Get the file display name for a sentinel value (for model visibility).
 */
export function getSentinelDisplay(hint?: string): string {
  if (hint) {
    return `[Credential file masked: ${hint}]`
  }
  return CREDENTIAL_SENTINEL
}
