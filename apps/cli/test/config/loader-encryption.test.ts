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

// ============================================================
// 一份手写的 config.yml 可以把 `apiKey` 写成任何 YAML 值。
//
// 同文件的兄弟读取器早已把这条不变式写在代码里 —— getProviderApiKey 的
// `typeof p.apiKey !== 'string'` 守卫就是它 —— 但 decryptProviderApiKeys
// 这一处没有施加。于是「配置里写了个数字」不再是「这个 provider 没配密钥」，
// 而是整个 CLI 起不来（.startsWith on a number）。
//
// 判据要能失败：修前每一条都抛，修后每一条都必须安静地当成「没有密钥」。
// ============================================================
describe('non-string apiKey / malformed providers do not crash config loading', () => {
  const MALFORMED: Array<[string, string]> = [
    ['a number', '    apiKey: 12345\n'],
    ['a boolean', '    apiKey: true\n'],
    ['an object', '    apiKey: { nested: value }\n'],
    ['an array', '    apiKey: [a, b]\n'],
  ]

  it.each(MALFORMED)('survives apiKey being %s — reads it as "no key"', (_label, line) => {
    const configPath = join(MIPHAM_HOME, 'config.yml')
    const readDeepseek = () => loadConfig(FAKE_CWD).providers.find((p) => p.id === 'deepseek')

    // Baseline: the same provider with `apiKey` omitted entirely.
    writeFileSync(configPath, 'version: 1\nproviders:\n  - id: deepseek\n', 'utf-8')
    const omitted = readDeepseek()

    writeFileSync(configPath, `version: 1\nproviders:\n  - id: deepseek\n${line}`, 'utf-8')
    expect(() => loadConfig(FAKE_CWD)).not.toThrow()

    // The contract is "a malformed value is treated as no value" — so compare
    // against the omitted case rather than against a literal I would be guessing.
    expect(readDeepseek()).toEqual(omitted)
  })

  it('survives a null entry in providers', () => {
    writeFileSync(join(MIPHAM_HOME, 'config.yml'), 'version: 1\nproviders:\n  - null\n', 'utf-8')
    expect(() => loadConfig(FAKE_CWD)).not.toThrow()
  })

  it('survives providers being a string', () => {
    writeFileSync(join(MIPHAM_HOME, 'config.yml'), 'version: 1\nproviders: nope\n', 'utf-8')
    expect(() => loadConfig(FAKE_CWD)).not.toThrow()
  })
})
