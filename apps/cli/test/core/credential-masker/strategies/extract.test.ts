import { describe, it, expect } from 'vitest'
import { ExtractMaskingStrategy } from '../../../../src/core/credential-masker/strategies/extract'
import type { CredentialExtractRule, CredentialFullMaskRule } from '../../../../src/shared/types'

describe('ExtractMaskingStrategy', () => {
  const strategy = new ExtractMaskingStrategy()

  it('canHandle returns true for extract mode', () => {
    const rule: CredentialExtractRule = { path: '**/*', mode: 'extract', extract: [] }
    expect(strategy.canHandle(rule)).toBe(true)
  })

  it('canHandle returns false for full mode', () => {
    const rule: CredentialFullMaskRule = { path: '**/*', mode: 'full' }
    expect(strategy.canHandle(rule)).toBe(false)
  })

  it('masks regex-matched tokens', () => {
    const rule: CredentialExtractRule = {
      path: '**/.env',
      mode: 'extract',
      extract: [{ pattern: 'SECRET=\\S+', replacement: 'SECRET=[MASKED]' }],
    }
    const result = strategy.mask('SECRET=abc123\nOTHER=keep', rule)
    expect(result).toBe('SECRET=[MASKED]\nOTHER=keep')
  })

  it('masks JSON field by key', () => {
    const rule: CredentialExtractRule = {
      path: '**/*.json',
      mode: 'extract',
      extract: [{ field: 'api_key', pattern: '.*', replacement: '[MASKED]' }],
    }
    const input = JSON.stringify({ api_key: 'sk-abc123', endpoint: 'https://api.example.com' })
    const result = strategy.mask(input, rule)
    const parsed = JSON.parse(result)
    expect(parsed.api_key).toBe('[MASKED]')
    expect(parsed.endpoint).toBe('https://api.example.com')
  })

  it('masks nested JSON field by dot-notation path', () => {
    const rule: CredentialExtractRule = {
      path: '**/*.json',
      mode: 'extract',
      extract: [{ field: 'auth.private_key', pattern: '.*', replacement: '[MASKED]' }],
    }
    const input = JSON.stringify({
      auth: { private_key: '-----BEGIN KEY-----', type: 'service_account' },
      name: 'test',
    })
    const result = strategy.mask(input, rule)
    const parsed = JSON.parse(result)
    expect(parsed.auth.private_key).toBe('[MASKED]')
    expect(parsed.auth.type).toBe('service_account')
    expect(parsed.name).toBe('test')
  })

  it('onExtractNoMatch: mask replaces all when no pattern matches', () => {
    const rule: CredentialExtractRule = {
      path: '**/*',
      mode: 'extract',
      extract: [{ pattern: 'NONEXISTENT_PATTERN_XYZ', replacement: 'X' }],
      onExtractNoMatch: 'mask',
    }
    const result = strategy.mask('some content here', rule)
    expect(result).toBe('__MIPHAM_CREDENTIAL_MASKED__')
  })

  it('onExtractNoMatch: passthrough keeps content when no pattern matches', () => {
    const rule: CredentialExtractRule = {
      path: '**/*',
      mode: 'extract',
      extract: [{ pattern: 'NONEXISTENT_PATTERN_XYZ', replacement: 'X' }],
      onExtractNoMatch: 'passthrough',
    }
    const result = strategy.mask('some content here', rule)
    expect(result).toBe('some content here')
  })

  it('default onExtractNoMatch is mask (backward compatible)', () => {
    const rule: CredentialExtractRule = {
      path: '**/*',
      mode: 'extract',
      extract: [{ pattern: 'NONEXISTENT_XYZ', replacement: 'X' }],
    }
    const result = strategy.mask('content', rule)
    expect(result).toBe('__MIPHAM_CREDENTIAL_MASKED__')
  })

  it('handles invalid JSON gracefully with regex fallback', () => {
    const rule: CredentialExtractRule = {
      path: '**/*',
      mode: 'extract',
      extract: [{ field: 'key', pattern: 'SECRET=\\S+', replacement: 'SECRET=[MASKED]' }],
    }
    const result = strategy.mask('SECRET=abc123', rule)
    // Falls back to regex on raw content since it's not valid JSON
    expect(result).toBe('SECRET=[MASKED]')
  })
})
