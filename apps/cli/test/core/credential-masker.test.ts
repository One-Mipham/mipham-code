import { describe, it, expect } from 'vitest'
import {
  matchCredentialFile,
  maskContent,
  maskOutput,
  filterEnv,
  CREDENTIAL_SENTINEL,
} from '../../src/core/credential-masker'
import type { CredentialMaskingConfig } from '../../src/shared/types'

// ── Helpers ──

function makeConfig(overrides: Partial<CredentialMaskingConfig> = {}): CredentialMaskingConfig {
  return {
    enabled: true,
    files: [],
    output_scrubbing: {
      enabled: true,
      patterns: ['(?i)(api[_-]?key|secret|token|password)\\s*[:=]\\s*\\S+'],
    },
    env_filter: {
      enabled: true,
      patterns: ['(?i)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)$'],
    },
    ...overrides,
  }
}

// ── Tests: matchCredentialFile ──

describe('matchCredentialFile', () => {
  it('should return null when config is disabled', () => {
    const config = makeConfig({ enabled: false, files: [{ path: '.env', mode: 'full' }] })
    expect(matchCredentialFile('/home/user/.env', config)).toBeNull()
  })

  it('should return null when no files configured', () => {
    const config = makeConfig()
    expect(matchCredentialFile('/home/user/.env', config)).toBeNull()
  })

  it('should match exact file path', () => {
    const config = makeConfig({ files: [{ path: '/home/user/.env', mode: 'full' }] })
    const rule = matchCredentialFile('/home/user/.env', config)
    expect(rule).not.toBeNull()
    expect(rule!.mode).toBe('full')
  })

  it('should match with ~ home expansion', () => {
    const { homedir } = require('node:os')
    const home = homedir()
    const config = makeConfig({ files: [{ path: '~/.aws/credentials', mode: 'full' }] })
    const rule = matchCredentialFile(`${home}/.aws/credentials`, config)
    expect(rule).not.toBeNull()
  })

  it('should match with ** globstar pattern', () => {
    const config = makeConfig({ files: [{ path: '**/.env', mode: 'full' }] })
    expect(matchCredentialFile('/home/user/.env', config)).not.toBeNull()
    expect(matchCredentialFile('/var/www/project/.env', config)).not.toBeNull()
  })

  it('should match with * wildcard within a segment', () => {
    const config = makeConfig({ files: [{ path: '~/.env*', mode: 'full' }] })
    const { homedir } = require('node:os')
    const home = homedir()
    expect(matchCredentialFile(`${home}/.env`, config)).not.toBeNull()
    expect(matchCredentialFile(`${home}/.env.local`, config)).not.toBeNull()
    expect(matchCredentialFile(`${home}/.env.production`, config)).not.toBeNull()
  })

  it('should not match unrelated files', () => {
    const config = makeConfig({ files: [{ path: '**/.env', mode: 'full' }] })
    expect(matchCredentialFile('/home/user/readme.md', config)).toBeNull()
  })
})

// ── Tests: maskContent ──

describe('maskContent', () => {
  it('should return sentinel for full mask mode', () => {
    const content = 'API_KEY=sk-abc123\nDATABASE_URL=postgres://localhost\n'
    const result = maskContent(content, { path: '.env', mode: 'full' })
    expect(result).toBe(CREDENTIAL_SENTINEL)
  })

  it('should replace extract regex matches with sentinel', () => {
    const content = 'apiKey: "sk-abc123"\nname: my-app\nsecret: "xyz-secret-456"\nport: 3000'
    const result = maskContent(content, {
      path: 'config.yml',
      mode: 'extract',
      extract: [
        { pattern: '(apiKey|secret)\\s*:\\s*"[^"]*"', replacement: '__MIPHAM_CREDENTIAL_MASKED__' },
      ],
    })

    expect(result).not.toContain('sk-abc123')
    expect(result).not.toContain('xyz-secret-456')
    expect(result).toContain('name: my-app')
    expect(result).toContain('port: 3000')
  })

  it('should handle invalid regex gracefully', () => {
    const content = 'test content'
    const result = maskContent(content, {
      path: 'test',
      mode: 'extract',
      extract: [{ pattern: '[invalid', replacement: 'X' }],
    })
    expect(result).toBe(content) // unchanged
  })

  it('should use custom replacement when provided', () => {
    const content = 'token: abc123'
    const result = maskContent(content, {
      path: 'test',
      mode: 'extract',
      extract: [{ pattern: 'abc123', replacement: '***REDACTED***' }],
    })
    expect(result).toBe('token: ***REDACTED***')
  })
})

// ── Tests: maskOutput ──

describe('maskOutput', () => {
  it('should scrub credential-like patterns from stdout', () => {
    const config = makeConfig()
    const output = 'Running with API_KEY=sk-abc123xyz\nConnecting...'
    const result = maskOutput(output, config)
    expect(result).not.toContain('sk-abc123xyz')
    expect(result).toContain(CREDENTIAL_SENTINEL)
    expect(result).toContain('Connecting...')
  })

  it('should not modify output without credential patterns', () => {
    const config = makeConfig()
    const output = 'Build successful\nAll tests passed'
    expect(maskOutput(output, config)).toBe(output)
  })

  it('should return unchanged when output_scrubbing disabled', () => {
    const config = makeConfig({ output_scrubbing: { enabled: false, patterns: [] } })
    const output = 'SECRET=mysecret'
    expect(maskOutput(output, config)).toBe(output)
  })

  it('should return unchanged when config disabled', () => {
    const config = makeConfig({ enabled: false })
    const output = 'TOKEN=abc'
    expect(maskOutput(output, config)).toBe(output)
  })
})

// ── Tests: filterEnv ──

describe('filterEnv', () => {
  it('should filter out env vars matching key patterns', () => {
    const config = makeConfig()
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      API_KEY: 'sk-secret',
      NPM_TOKEN: 'npm_xxx',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      NODE_ENV: 'development',
    }
    const result = filterEnv(env, config)

    expect(result.PATH).toBe('/usr/bin')
    expect(result.HOME).toBe('/home/user')
    expect(result.NODE_ENV).toBe('development')
    expect(result.API_KEY).toBe(CREDENTIAL_SENTINEL)
    expect(result.NPM_TOKEN).toBe(CREDENTIAL_SENTINEL)
    expect(result.AWS_SECRET_ACCESS_KEY).toBe(CREDENTIAL_SENTINEL)
  })

  it('should return copy when env_filter disabled', () => {
    const config = makeConfig({ env_filter: { enabled: false, patterns: [] } })
    const env = { API_KEY: 'secret' }
    const result = filterEnv(env, config)
    expect(result.API_KEY).toBe('secret')
  })

  it('should return copy when config disabled', () => {
    const config = makeConfig({ enabled: false })
    const env = { API_KEY: 'secret' }
    const result = filterEnv(env, config)
    expect(result.API_KEY).toBe('secret')
  })

  it('should not modify original env object', () => {
    const config = makeConfig()
    const env = { API_KEY: 'secret', HOME: '/home' }
    filterEnv(env, config)
    expect(env.API_KEY).toBe('secret') // original unchanged
  })
})
