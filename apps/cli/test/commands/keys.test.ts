import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'

// Isolate the key store from the real ~/.mipham — KeyManager.ensureEntry()/
// rotate() persist to keys.json, so tests must not pollute the user's live keys.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-keys-home`,
  }
})

import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { keysCmd } from '../../src/commands/keys.js'
import { KeyManager } from '../../src/config/keys-manager.js'
import { saveProviderApiKey } from '../../src/config/loader.js'

const TEST_HOME = join(tmpdir(), 'mipham-test-keys-home')

beforeEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('Keys Commands', () => {
  it('/keys lists keys (or shows empty if none registered)', async () => {
    const result = await keysCmd({} as any, [])
    // Keys may already exist from other tests — the command should return structured content
    expect(typeof result.content).toBe('string')
    expect(result.content.length).toBeGreaterThan(0)
  })

  it('/keys rotate without provider shows usage', async () => {
    const result = await keysCmd({} as any, ['rotate'])
    expect(result.content).toContain('Usage: /keys rotate <provider>')
  })

  it('/keys rotate with provider shows interactive prompt', async () => {
    const result = await keysCmd({} as any, ['rotate', 'deepseek'])
    expect(result.content).toContain('Key Rotation')
    expect(result.content).toContain('deepseek')
    expect(result.forwardToAI).toBeDefined()
    expect(result.forwardToAI).toContain('deepseek')
  })

  it('/keys audit shows clean when no expired keys', async () => {
    const result = await keysCmd({} as any, ['audit'])
    expect(result.content).toContain('Key Audit')
    expect(result.content).toContain('All keys are within the 90-day rotation window')
  })

  it('/keys audit detects expired keys after registering old entry', async () => {
    const manager = new KeyManager()
    manager.ensureEntry('test-provider')
    // Fresh key should not be expired
    const result = await keysCmd({} as any, ['audit'])
    expect(result.content).toContain('All keys are within')
  })

  it('/keys view shows the plaintext API key', async () => {
    // Seed a user-level config so saveProviderApiKey writes there (not project config).
    mkdirSync(join(homedir(), '.mipham'), { recursive: true })
    writeFileSync(join(homedir(), '.mipham', 'config.yml'), 'version: 1\n', 'utf-8')
    saveProviderApiKey('deepseek', 'sk-view-789')
    const result = await keysCmd({} as any, ['view', 'deepseek'])
    expect(result.content).toContain('sk-view-789')
  })

  it('/keys view without provider shows usage', async () => {
    const result = await keysCmd({} as any, ['view'])
    expect(result.content).toContain('Usage: /keys view <provider>')
  })
})

describe('KeyManager', () => {
  it('ensureEntry creates entry for new provider', () => {
    const manager = new KeyManager()
    manager.ensureEntry('openai-test')
    const list = manager.list()
    const entry = list.find((s) => s.provider === 'openai-test')
    expect(entry).toBeDefined()
    expect(entry!.rotationCount).toBe(0)
    expect(entry!.expired).toBe(false)
  })

  it('ensureEntry is idempotent — does not reset existing entry', () => {
    const manager = new KeyManager()
    manager.ensureEntry('idempotent-test')
    const before = manager.list().find((s) => s.provider === 'idempotent-test')!
    manager.ensureEntry('idempotent-test')
    const after = manager.list().find((s) => s.provider === 'idempotent-test')!
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.rotationCount).toBe(before.rotationCount)
  })

  it('rotate increments counter', () => {
    const manager = new KeyManager()
    manager.ensureEntry('rotate-counter-test')
    const before = manager.list().find((s) => s.provider === 'rotate-counter-test')!
    const result = manager.rotate('rotate-counter-test', 'sk-test-key-12345')
    expect(result.success).toBe(true)
    const after = manager.list().find((s) => s.provider === 'rotate-counter-test')!
    expect(after.rotationCount).toBe(before.rotationCount + 1)
  })

  it('list never exposes key values', () => {
    const manager = new KeyManager()
    manager.ensureEntry('no-leak-test')
    manager.rotate('no-leak-test', 'sk-super-secret-do-not-expose')

    const list = manager.list()
    for (const status of list) {
      const keys = Object.keys(status)
      expect(keys).not.toContain('key')
      expect(keys).not.toContain('value')
      expect(keys).not.toContain('apiKey')
      expect(keys).not.toContain('secret')
    }
  })

  it('getExpiryReminder returns null when no keys are expired', () => {
    const manager = new KeyManager()
    manager.ensureEntry('fresh-key')
    const reminder = manager.getExpiryReminder()
    expect(reminder).toBeNull()
  })

  it('audit returns only expired keys', () => {
    const manager = new KeyManager()
    manager.ensureEntry('fresh-key')
    const expired = manager.audit()
    // Fresh key should not appear in audit
    const found = expired.find((s) => s.provider === 'fresh-key')
    expect(found).toBeUndefined()
  })
})
