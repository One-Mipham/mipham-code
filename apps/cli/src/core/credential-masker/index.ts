export { CREDENTIAL_SENTINEL } from './types'
export type { MaskingStrategy } from './types'

export { MaskingPipeline, getPipeline, maskContent } from './pipeline'
export { matchCredentialFile, matchPath, globToRegex } from './matcher'
export { filterEnv } from './env-filter'
export { maskOutput } from './output-scrub'

// Strategies
export { FullMaskingStrategy } from './strategies/full'
export { ExtractMaskingStrategy } from './strategies/extract'
export { JwtMaskingStrategy } from './strategies/jwt'

import { getPipeline } from './pipeline'
import { FullMaskingStrategy } from './strategies/full'
import { ExtractMaskingStrategy } from './strategies/extract'
import { JwtMaskingStrategy } from './strategies/jwt'

/**
 * Initialize the masking pipeline with all built-in strategies.
 * Call once at startup. Safe to call multiple times (idempotent).
 */
let _initialized = false

export function initializePipeline(): void {
  if (_initialized) return
  const pipeline = getPipeline()
  pipeline.register(new FullMaskingStrategy())
  pipeline.register(new ExtractMaskingStrategy())
  pipeline.register(new JwtMaskingStrategy())
  _initialized = true
}
