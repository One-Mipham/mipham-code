import type { MaskingStrategy } from '../types'
import type { CredentialFileRule, CredentialExtractRule } from '../../../shared/index.ts'
import { CREDENTIAL_SENTINEL } from '../types'

export class ExtractMaskingStrategy implements MaskingStrategy {
  readonly name = 'extract'

  canHandle(rule: CredentialFileRule): rule is CredentialExtractRule {
    return 'mode' in rule && rule.mode === 'extract' && !('type' in rule)
  }

  mask(content: string, rule: CredentialExtractRule): string {
    let masked = content
    let anyMatch = false

    for (const extractRule of rule.extract) {
      const replacement = extractRule.replacement || CREDENTIAL_SENTINEL

      if (extractRule.field) {
        // Structured extraction: extract field by key before applying pattern
        masked = this.maskField(masked, extractRule.field, extractRule.pattern, replacement)
        anyMatch = true // field extraction always applies
      } else {
        // Traditional regex extraction
        try {
          const regex = new RegExp(extractRule.pattern, 'gm')
          if (regex.test(masked)) {
            anyMatch = true
            // Re-create regex since test() advances lastIndex
            const re = new RegExp(extractRule.pattern, 'gm')
            masked = masked.replace(re, replacement)
          }
        } catch {
          // Invalid regex — skip
        }
      }
    }

    // Handle onExtractNoMatch
    const onNoMatch = rule.onExtractNoMatch || 'mask'
    if (!anyMatch && onNoMatch === 'mask') {
      return CREDENTIAL_SENTINEL
    }

    return masked
  }

  /**
   * Extract a JSON field by key and apply pattern masking to its value.
   * Supports nested keys with dot notation (e.g. "auth.api_key").
   */
  private maskField(
    content: string,
    fieldPath: string,
    pattern: string,
    replacement: string,
  ): string {
    try {
      // Try parsing as JSON
      const parsed = JSON.parse(content)
      this.setNestedValue(parsed, fieldPath, (value) => {
        if (typeof value === 'string') {
          try {
            const regex = new RegExp(pattern)
            return value.replace(regex, replacement)
          } catch {
            return replacement
          }
        }
        return replacement
      })
      return JSON.stringify(parsed, null, 2)
    } catch {
      // Not valid JSON — fall back to regex on raw content
      try {
        const regex = new RegExp(pattern, 'gm')
        return content.replace(regex, replacement)
      } catch {
        return content
      }
    }
  }

  /**
   * Set a nested value in an object using dot-notation path.
   */
  private setNestedValue(
    obj: Record<string, unknown>,
    path: string,
    transform: (value: unknown) => unknown,
  ): void {
    const keys = path.split('.')
    let current: Record<string, unknown> = obj

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i]!
      if (!current[key] || typeof current[key] !== 'object') return
      current = current[key] as Record<string, unknown>
    }

    const lastKey = keys[keys.length - 1]!
    if (lastKey in current) {
      current[lastKey] = transform(current[lastKey])
    }
  }
}
