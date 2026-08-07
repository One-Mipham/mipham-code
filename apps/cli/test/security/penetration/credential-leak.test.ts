import { describe, it, expect } from 'vitest'
import { SecurityGate } from '../../../src/security/gate'

describe('credential leak detection', () => {
  it('detects Anthropic API key (sk-ant-)', () => {
    const result = SecurityGate.checkCredentialLeak(
      'here is my key: sk-ant-api03-abc123def456ghi789jkl',
    )
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('anthropic-key')
  })

  it('detects OpenAI-style API key (sk-)', () => {
    const result = SecurityGate.checkCredentialLeak(
      'export OPENAI_KEY=sk-proj1234567890abcdef1234567890ab',
    )
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('openai-key')
  })

  it('detects JWT token', () => {
    const result = SecurityGate.checkCredentialLeak(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR',
    )
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('jwt-token')
  })

  it('detects x-api-key header', () => {
    const result = SecurityGate.checkCredentialLeak('x-api-key: abcdef1234567890abcdef')
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('api-key-header')
  })

  it('allows normal output without credentials', () => {
    const result = SecurityGate.checkCredentialLeak('Test results: 42 tests passed, 0 failed')
    expect(result.blocked).toBe(false)
  })
})
