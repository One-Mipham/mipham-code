import { describe, it, expect } from 'vitest'
import {
  encrypt,
  decrypt,
  getOrCreateKey,
  getCredentialKey,
  encryptApiKey,
  decryptApiKey,
  isEnvTemplate,
  ENC_PREFIX,
} from '../../src/config/credential-crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('credential-crypto', () => {
  it('encrypt/decrypt roundtrip', () => {
    const key = getOrCreateKey(join(tmpdir(), 'cred-test-key-a'))
    const ciphertext = encrypt('secret', key)
    expect(ciphertext).not.toContain('secret')
    expect(decrypt(ciphertext, key)).toBe('secret')
  })

  it('decrypt throws on wrong key or corrupt data', () => {
    const key1 = getOrCreateKey(join(tmpdir(), 'cred-test-key-b1'))
    const key2 = getOrCreateKey(join(tmpdir(), 'cred-test-key-b2'))
    const ciphertext = encrypt('secret', key1)
    expect(() => decrypt(ciphertext, key2)).toThrow()
    expect(() => decrypt('garbage', key1)).toThrow()
  })

  it('encryptApiKey prefixes literal secrets with enc:v1:', () => {
    const key = getOrCreateKey(join(tmpdir(), 'cred-test-key-c'))
    const stored = encryptApiKey('sk-live-123', key)
    expect(stored.startsWith(ENC_PREFIX)).toBe(true)
    expect(stored).not.toContain('sk-live-123')
    expect(decryptApiKey(stored, key)).toBe('sk-live-123')
  })

  it('encryptApiKey skips env templates and empty values', () => {
    const key = getOrCreateKey(join(tmpdir(), 'cred-test-key-d'))
    expect(encryptApiKey('${OPENAI_API_KEY}', key)).toBe('${OPENAI_API_KEY}')
    expect(encryptApiKey('$OPENAI_API_KEY', key)).toBe('$OPENAI_API_KEY')
    expect(encryptApiKey('', key)).toBe('')
  })

  it('decryptApiKey passes plaintext through unchanged', () => {
    const key = getOrCreateKey(join(tmpdir(), 'cred-test-key-e'))
    expect(decryptApiKey('plaintext-key', key)).toBe('plaintext-key')
    expect(decryptApiKey('${VAR}', key)).toBe('${VAR}')
  })

  it('isEnvTemplate detects both ${VAR} and $VAR forms', () => {
    expect(isEnvTemplate('${FOO}')).toBe(true)
    expect(isEnvTemplate('$FOO')).toBe(true)
    expect(isEnvTemplate('sk-abc')).toBe(false)
    expect(isEnvTemplate('')).toBe(false)
  })

  it('getCredentialKey migrates legacy .mcp-key to .cred-key', () => {
    const dir = join(tmpdir(), `cred-keydir-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.mcp-key'), 'x'.repeat(32))
    const key = getCredentialKey(dir)
    expect(key.toString('utf-8')).toBe('x'.repeat(32))
    expect(existsSync(join(dir, '.cred-key'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
