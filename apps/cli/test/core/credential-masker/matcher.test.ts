import { homedir } from 'node:os'
import { describe, it, expect } from 'vitest'
import { matchPath, globToRegex, matchCredentialFile } from '../../../src/core/credential-masker/matcher'
import type { CredentialMaskingConfig } from '../../../src/shared/types'

describe('matchPath', () => {
  it('exact match', () => {
    expect(matchPath('/home/user/.env', '/home/user/.env')).toBe(true)
  })

  it('globstar ** matches any depth', () => {
    expect(matchPath('/home/user/.aws/credentials', '**/.aws/credentials')).toBe(true)
    expect(matchPath('/a/b/c/d/.aws/credentials', '**/.aws/credentials')).toBe(true)
  })

  it('single * matches within segment', () => {
    expect(matchPath('/home/user/.env.local', '/home/user/.env.*')).toBe(true)
    expect(matchPath('/home/user/.env', '/home/user/.env.*')).toBe(true)
  })

  it('? matches single char', () => {
    expect(matchPath('/home/user/.env', '/home/user/.en?')).toBe(true)
    expect(matchPath('/home/user/.en', '/home/user/.en?')).toBe(false)
  })

  it('tilde expands to home', () => {
    const home = homedir()
    expect(matchPath(home + '/.env', '~/.env')).toBe(true)
  })

  it('basename matching', () => {
    expect(matchPath('/some/deep/path/.env.prod', '.env*')).toBe(true)
  })

  it('no match returns false', () => {
    expect(matchPath('/home/user/config.yml', '.env*')).toBe(false)
  })
})

describe('matchCredentialFile', () => {
  const baseConfig: CredentialMaskingConfig = {
    enabled: true,
    files: [
      { path: '**/.env', mode: 'full' },
      { path: '**/.aws/credentials', mode: 'extract', extract: [{ pattern: '.*' }] },
    ],
    output_scrubbing: { enabled: false, patterns: [] },
    env_filter: { enabled: false, patterns: [] },
  }

  it('matches globstar rule', () => {
    const result = matchCredentialFile('/home/user/project/.env', baseConfig)
    expect(result).not.toBeNull()
    expect(result).toHaveProperty('mode', 'full')
  })

  it('returns null when disabled', () => {
    const disabled = { ...baseConfig, enabled: false }
    expect(matchCredentialFile('/home/user/.env', disabled)).toBeNull()
  })

  it('returns null for no match', () => {
    expect(matchCredentialFile('/home/user/safe.txt', baseConfig)).toBeNull()
  })
})
