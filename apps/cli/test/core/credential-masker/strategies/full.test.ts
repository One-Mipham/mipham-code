import { describe, it, expect } from 'vitest'
import { FullMaskingStrategy } from '../../../../src/core/credential-masker/strategies/full'
import type { CredentialFullMaskRule, CredentialExtractRule } from '../../../../src/shared/types'

describe('FullMaskingStrategy', () => {
  const strategy = new FullMaskingStrategy()

  it('canHandle returns true for full mode rules', () => {
    const rule: CredentialFullMaskRule = { path: '**/.env', mode: 'full' }
    expect(strategy.canHandle(rule)).toBe(true)
  })

  it('canHandle returns false for extract mode rules', () => {
    const rule: CredentialExtractRule = { path: '**/*', mode: 'extract', extract: [] }
    expect(strategy.canHandle(rule)).toBe(false)
  })

  it('mask replaces all content with sentinel', () => {
    const rule: CredentialFullMaskRule = { path: '**/*', mode: 'full' }
    expect(strategy.mask('SECRET=abc\nTOKEN=xyz', rule)).toBe('__MIPHAM_CREDENTIAL_MASKED__')
  })
})
