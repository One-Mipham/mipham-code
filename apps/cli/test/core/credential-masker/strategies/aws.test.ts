import { describe, it, expect } from 'vitest'
import { AwsMaskingStrategy } from '../../../../src/core/credential-masker/strategies/aws'
import type { AwsMaskingRule, CredentialExtractRule } from '../../../../src/shared/types'

describe('AwsMaskingStrategy', () => {
  const strategy = new AwsMaskingStrategy()

  it('canHandle returns true for AWS rules', () => {
    const rule: AwsMaskingRule = {
      path: '**/.aws/credentials',
      type: 'aws',
      awsPairs: true,
      sigv4: false,
    }
    expect(strategy.canHandle(rule)).toBe(true)
  })

  it('canHandle returns false for non-AWS rules', () => {
    const rule: CredentialExtractRule = { path: '**/*', mode: 'extract', extract: [] }
    expect(strategy.canHandle(rule)).toBe(false)
  })

  it('masks AWS access key preserving prefix', () => {
    const rule: AwsMaskingRule = { path: '**/*', type: 'aws', awsPairs: true, sigv4: false }
    const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'
    const result = strategy.mask(input, rule)
    expect(result).toContain('AKIAIOSF')
    expect(result).toContain('__MIPHAM_CREDENTIAL_MASKED__')
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('masks AWS secret access key fully', () => {
    const rule: AwsMaskingRule = { path: '**/*', type: 'aws', awsPairs: true, sigv4: false }
    const input = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    const result = strategy.mask(input, rule)
    expect(result).toContain('__MIPHAM_CREDENTIAL_MASKED__')
    expect(result).not.toContain('wJalrXUtnFEMI')
  })

  it('masks INI-format AWS credentials', () => {
    const rule: AwsMaskingRule = { path: '**/*', type: 'aws', awsPairs: true, sigv4: false }
    const input = `[default]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
region = us-east-1`
    const result = strategy.mask(input, rule)
    expect(result).toContain('AKIAIOSF')
    expect(result).toContain('__MIPHAM_CREDENTIAL_MASKED__')
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(result).not.toContain('wJalrXUtnFEMI')
    expect(result).toContain('region = us-east-1') // non-sensitive line preserved
  })

  it('skips masking when awsPairs is false', () => {
    const rule: AwsMaskingRule = { path: '**/*', type: 'aws', awsPairs: false, sigv4: false }
    const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'
    const result = strategy.mask(input, rule)
    expect(result).toBe(input) // unchanged
  })

  it('masks only access keys with valid AKIA/ASIA prefix', () => {
    const rule: AwsMaskingRule = { path: '**/*', type: 'aws', awsPairs: true, sigv4: false }
    const input = 'SOME_OTHER_ID=NOTANACCESSKEY123456'
    const result = strategy.mask(input, rule)
    expect(result).toBe(input) // unchanged — not an AWS key prefix
  })

  it('handles content with no AWS keys', () => {
    const rule: AwsMaskingRule = { path: '**/*', type: 'aws', awsPairs: true, sigv4: false }
    const input = 'Just some regular config\nno keys here'
    const result = strategy.mask(input, rule)
    expect(result).toBe(input)
  })
})
