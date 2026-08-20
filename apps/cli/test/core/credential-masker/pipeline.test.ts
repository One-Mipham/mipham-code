import { describe, it, expect, beforeEach } from 'vitest'
import { MaskingPipeline, maskContent } from '../../../src/core/credential-masker/pipeline'
import type { MaskingStrategy } from '../../../src/core/credential-masker/types'
import type {
  CredentialFullMaskRule,
  CredentialExtractRule,
  JwtMaskingRule,
} from '../../../src/shared/types'

describe('MaskingPipeline', () => {
  let pipeline: MaskingPipeline

  beforeEach(() => {
    pipeline = new MaskingPipeline()
  })

  it('falls back to full mode when no strategy matches', () => {
    const rule: CredentialFullMaskRule = { path: '**/.env', mode: 'full' }
    const result = pipeline.maskContent('SECRET=abc123', rule)
    expect(result).toBe('__MIPHAM_CREDENTIAL_MASKED__')
  })

  it('falls back to extract mode when no strategy matches', () => {
    const rule: CredentialExtractRule = {
      path: '**/.env',
      mode: 'extract',
      extract: [{ pattern: 'SECRET=\\S+', replacement: 'SECRET=[MASKED]' }],
    }
    const result = pipeline.maskContent('SECRET=abc123\nOTHER=keep', rule)
    expect(result).toBe('SECRET=[MASKED]\nOTHER=keep')
  })

  it('uses registered strategy when canHandle returns true', () => {
    const customStrategy: MaskingStrategy = {
      name: 'test',
      canHandle: (rule) => 'type' in rule && (rule as any).type === 'jwt',
      mask: () => '[JWT_MASKED_BY_CUSTOM]',
    }
    pipeline.register(customStrategy)

    const rule: JwtMaskingRule = {
      path: '**/token.json',
      type: 'jwt',
      decode: 'jwt',
      maskClaims: ['sub'],
    }
    const result = pipeline.maskContent('eyJh.eyJzdWIiOiIxMjMifQ.sig', rule)
    expect(result).toBe('[JWT_MASKED_BY_CUSTOM]')
  })

  it('later registrations checked first (LIFO)', () => {
    const first: MaskingStrategy = {
      name: 'first',
      canHandle: () => true,
      mask: () => 'first',
    }
    const second: MaskingStrategy = {
      name: 'second',
      canHandle: () => true,
      mask: () => 'second',
    }
    pipeline.register(first)
    pipeline.register(second)

    const result = pipeline.maskContent('any', { path: '**/*', mode: 'full' })
    expect(result).toBe('second') // last registered = first checked
  })

  it('skips non-matching strategies and falls through', () => {
    const neverMatches: MaskingStrategy = {
      name: 'never',
      canHandle: () => false,
      mask: () => 'should not be called',
    }
    pipeline.register(neverMatches)

    const rule: CredentialFullMaskRule = { path: '**/*', mode: 'full' }
    const result = pipeline.maskContent('data', rule)
    expect(result).toBe('__MIPHAM_CREDENTIAL_MASKED__') // fallback
  })
})

describe('maskContent convenience function', () => {
  it('returns sentinel for full mode', () => {
    const rule: CredentialFullMaskRule = { path: '**/*', mode: 'full' }
    expect(maskContent('anything', rule)).toBe('__MIPHAM_CREDENTIAL_MASKED__')
  })
})
