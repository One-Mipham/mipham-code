import type { CredentialFileRule } from '../../shared/index.ts'

/** Sentinel value used to replace masked credentials. */
export const CREDENTIAL_SENTINEL = '__MIPHAM_CREDENTIAL_MASKED__'

/** Strategy interface for credential masking. Each strategy handles one rule type. */
export interface MaskingStrategy {
  /** Unique name for this strategy. */
  readonly name: string

  /** Return true if this strategy handles the given rule. */
  canHandle(rule: CredentialFileRule): boolean

  /** Apply masking to content according to the rule. Returns masked content. */
  mask(content: string, rule: CredentialFileRule): string
}
