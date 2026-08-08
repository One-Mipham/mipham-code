import type { CredentialFileRule } from '../../shared/index.ts'
import type { MaskingStrategy } from './types'
import { CREDENTIAL_SENTINEL } from './types'

/**
 * MaskingPipeline chains multiple MaskingStrategy instances.
 * When maskContent is called, the first strategy whose canHandle()
 * returns true performs the masking. If no strategy matches, falls
 * back to legacy full/extract behavior.
 */
export class MaskingPipeline {
  private strategies: MaskingStrategy[] = []

  /** Register a strategy. Later registrations take priority (checked first). */
  register(strategy: MaskingStrategy): void {
    this.strategies.unshift(strategy)
  }

  /** Apply masking to content according to a rule. */
  maskContent(content: string, rule: CredentialFileRule): string {
    for (const strategy of this.strategies) {
      if (strategy.canHandle(rule)) {
        return strategy.mask(content, rule)
      }
    }

    // Fallback to legacy full/extract behavior
    if ('mode' in rule && rule.mode === 'full') {
      return CREDENTIAL_SENTINEL
    }

    // Legacy extract mode
    if ('mode' in rule && 'extract' in rule && Array.isArray(rule.extract)) {
      let masked = content
      for (const extractRule of rule.extract) {
        const replacement = extractRule.replacement || CREDENTIAL_SENTINEL
        try {
          const regex = new RegExp(extractRule.pattern, 'gm')
          masked = masked.replace(regex, replacement)
        } catch {
          // Invalid regex — skip this rule silently
        }
      }
      return masked
    }

    return content
  }
}

/** Singleton pipeline instance. */
let _pipeline: MaskingPipeline | null = null

export function getPipeline(): MaskingPipeline {
  if (!_pipeline) {
    _pipeline = new MaskingPipeline()
  }
  return _pipeline
}

/**
 * Convenience function matching the original maskContent signature.
 * Uses the singleton pipeline.
 */
export function maskContent(content: string, rule: CredentialFileRule): string {
  return getPipeline().maskContent(content, rule)
}