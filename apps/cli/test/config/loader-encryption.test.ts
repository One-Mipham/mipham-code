import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Isolate config loading from the real ~/.mipham — loadConfig/saveProviderApiKey
// read and write config.yml + the credential key, so tests must not touch the
// user's live config.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-enc`,
  }
})

import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { saveProviderApiKey, loadConfig, getProviderApiKey } from '../../src/config/loader'
import { ENC_PREFIX } from '../../src/config/credential-crypto'

const MIPHAM_HOME = join(homedir(), '.mipham')
const FAKE_CWD = join(homedir(), 'fake-cwd')

beforeEach(() => {
  rmSync(MIPHAM_HOME, { recursive: true, force: true })
  mkdirSync(MIPHAM_HOME, { recursive: true })
  // Pre-seed a valid user config so saveProviderApiKey writes to the user-level
  // config (preferred) instead of falling back to project config at process.cwd().
  writeFileSync(join(MIPHAM_HOME, 'config.yml'), 'version: 1\n', 'utf-8')
})

afterEach(() => {
  rmSync(MIPHAM_HOME, { recursive: true, force: true })
})

describe('config.yml API key encryption', () => {
  it('saveProviderApiKey encrypts the key at rest', () => {
    saveProviderApiKey('deepseek', 'sk-live-secret-123')
    const raw = readFileSync(join(MIPHAM_HOME, 'config.yml'), 'utf-8')
    expect(raw).not.toContain('sk-live-secret-123')
    expect(raw).toContain(ENC_PREFIX)
  })

  it('loadConfig decrypts the key back to plaintext', () => {
    saveProviderApiKey('deepseek', 'sk-live-secret-123')
    const config = loadConfig(FAKE_CWD)
    const deepseek = config.providers.find((p) => p.id === 'deepseek')
    expect(deepseek?.apiKey).toBe('sk-live-secret-123')
  })

  it('loadConfig reads legacy plaintext keys unchanged (backward compat)', () => {
    writeFileSync(
      join(MIPHAM_HOME, 'config.yml'),
      'version: 1\nproviders:\n  - id: openai\n    apiKey: sk-legacy-plaintext\n',
      'utf-8',
    )
    const config = loadConfig(FAKE_CWD)
    const openai = config.providers.find((p) => p.id === 'openai')
    expect(openai?.apiKey).toBe('sk-legacy-plaintext')
  })

  it('getProviderApiKey returns the decrypted plaintext key', () => {
    saveProviderApiKey('deepseek', 'sk-view-me-456')
    expect(getProviderApiKey('deepseek')).toBe('sk-view-me-456')
  })

  it('getProviderApiKey returns null for an unknown provider', () => {
    expect(getProviderApiKey('nonexistent')).toBeNull()
  })
})
