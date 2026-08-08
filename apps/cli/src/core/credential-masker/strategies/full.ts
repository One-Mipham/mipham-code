import type { MaskingStrategy } from '../types'
import type { CredentialFileRule, CredentialFullMaskRule } from '../../../shared/index.ts'
import { CREDENTIAL_SENTINEL } from '../types'

export class FullMaskingStrategy implements MaskingStrategy {
  readonly name = 'full'

  canHandle(rule: CredentialFileRule): rule is CredentialFullMaskRule {
    return 'mode' in rule && rule.mode === 'full' && !('type' in rule)
  }

  mask(_content: string, _rule: CredentialFullMaskRule): string {
    return CREDENTIAL_SENTINEL
  }
}
