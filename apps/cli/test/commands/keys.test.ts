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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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
  it('keys.json 存的是合法 JSON 但不是一个键表时按空处理，而不是抛', () => {
    // `null` 是这里最要命的一个：`JSON.parse` 接受它，`loadKeys` 原先直接当
    // `KeysData` 返回，然后 `Object.entries(null)` 在 **list() 里**抛 —— 也就是
    // 启动路径上，不是某个角落。/keys 一敲就崩。
    const keysFile = join(TEST_HOME, '.mipham', 'keys.json')
    mkdirSync(join(TEST_HOME, '.mipham'), { recursive: true })

    for (const bad of ['null', '"x"', '[1,2]', '7']) {
      writeFileSync(keysFile, bad, 'utf-8')
      const manager = new KeyManager()
      expect(manager.list()).toEqual([])
    }
  })

  it('合法的键表仍然照常读出来（正控：上面的判据不是恒真的）', () => {
    const manager = new KeyManager()
    manager.ensureEntry('control-provider')
    expect(new KeyManager().list().map((s) => s.provider)).toContain('control-provider')
  })

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

  // ============================================================
  // keys.json 的写路径曾经是「转了一半」：先写一个固定名的 `.tmp`，**然后不 rename、
  // 直接再写一遍目标**。丢在磁盘上的 `.tmp` 是废物，目标仍然非原子 —— 并发
  // `/keys rotate` 撞进同一个临时名，或写到一半被打断，`loadKeys` 把不可解析的
  // JSON 吞成 `{}`（:35-37），全部轮换元数据静默消失。
  // ============================================================
  it('保存后不留固定名的 .tmp 残骸（写的是同一个原子路径）', () => {
    const manager = new KeyManager()
    manager.ensureEntry('anthropic')

    const keysFile = join(TEST_HOME, '.mipham', 'keys.json')
    expect(existsSync(keysFile)).toBe(true) // 正控：它确实写了目标文件
    expect(JSON.parse(readFileSync(keysFile, 'utf-8')).anthropic).toBeTruthy()
    expect(existsSync(keysFile + '.tmp')).toBe(false)
    expect(readdirSync(join(TEST_HOME, '.mipham')).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('rotate 之后同样不留 .tmp 残骸，且换 inode（rename 而非原地重写）', () => {
    const manager = new KeyManager()
    manager.ensureEntry('anthropic')

    const keysFile = join(TEST_HOME, '.mipham', 'keys.json')
    const before = statSync(keysFile).ino
    manager.rotate('anthropic', 'sk-test-atomic-write')

    expect(JSON.parse(readFileSync(keysFile, 'utf-8')).anthropic).toBeTruthy()
    expect(existsSync(keysFile + '.tmp')).toBe(false)
    expect(statSync(keysFile).ino).not.toBe(before)
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
