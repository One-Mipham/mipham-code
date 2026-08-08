import type { MaskingStrategy } from '../types'
import type { CredentialFileRule, AwsMaskingRule } from '../../../shared/index.ts'
import { CREDENTIAL_SENTINEL } from '../types'

/**
 * AWS credential masking strategy.
 *
 * Phase 1: Detects AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY pairs
 * and masks the secret key while preserving partial access key for context.
 * SigV4 re-signing is deferred to Phase 2 (requires TLS termination).
 */
export class AwsMaskingStrategy implements MaskingStrategy {
  readonly name = 'aws'

  // Patterns for AWS credential formats
  private static readonly ACCESS_KEY_PATTERN = /(?:AWS_ACCESS_KEY_ID|aws_access_key_id)\s*[:=]\s*([A-Z0-9]{16,})/gi
  private static readonly SECRET_KEY_PATTERN = /(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key)\s*[:=]\s*([A-Za-z0-9/+=]{40,})/gi
  private static readonly INI_KEY_PATTERN = /aws_access_key_id\s*=\s*([A-Z0-9]{16,})/gi
  private static readonly INI_SECRET_PATTERN = /aws_secret_access_key\s*=\s*([A-Za-z0-9/+=]{40,})/gi

  canHandle(rule: CredentialFileRule): rule is AwsMaskingRule {
    return 'type' in rule && rule.type === 'aws'
  }

  mask(content: string, rule: AwsMaskingRule): string {
    if (!rule.awsPairs) return content

    let masked = content

    // Mask access key: keep AKIA/ASIA prefix + first 4 chars for context
    masked = masked.replace(
      /(?:AWS_ACCESS_KEY_ID|aws_access_key_id)\s*[:=]\s*/gi,
      (match) => match, // preserve the key name
    )

    // Mask access key values — keep prefix for model context
    masked = masked.replace(
      /((?:AKIA|ASIA)[A-Z0-9]{12,})/g,
      (_full, key: string) => {
        const prefix = key.slice(0, 8) // "AKIAXXXX"
        return `${prefix}${CREDENTIAL_SENTINEL}`
      },
    )

    // Mask secret access key values — fully mask (no context needed)
    masked = masked.replace(
      /(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key)\s*[:=]\s*([A-Za-z0-9/+=]{40,})/gi,
      (match) => {
        const parts = match.split(/[:=]\s*/)
        return `${parts[0]}=${CREDENTIAL_SENTINEL}`
      },
    )

    // Also mask inline secret key patterns (bare base64-like strings near key markers)
    masked = masked.replace(
      /(?:aws_secret_access_key|secret_access_key|SECRET_ACCESS_KEY)\s*[:=]\s*([A-Za-z0-9/+=]{40,})/gi,
      (match) => {
        const parts = match.split(/[:=]\s*/)
        return `${parts[0]}=${CREDENTIAL_SENTINEL}`
      },
    )

    return masked
  }
}
