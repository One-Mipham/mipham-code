import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

// ============================================================
// 共享凭据密钥（`~/.mipham/.cred-key`）是所有 `enc:v1:` 密文的**唯一**钥匙。
//
// `getOrCreateKey` 的写法是 existsSync → 生成 → 裸 `writeFileSync`。这条缝隙里
// 有第二个进程时（CLI 与 daemon worker 同机并发是常态），它写下的密钥会被
// **整份覆盖**：此后两边的密文各认一把钥匙，谁也解不开对方的 —— 而覆盖发生的
// 那一刻没有任何报错，静默地丢。
//
// 同一处的第二条是**权限**：裸写在 umask 022 下落成 0644（同目录的其他用户可读），
// 靠**事后** chmodSync 补救 —— 崩在两者之间就永久停在 0644；而已存在为 0644 的
// 密钥在读取路径上**永远不会被收紧**。
//
// 同步 fs 在单进程里没法真并发，所以 C1 用**探针**造出那个交错：让 existsSync
// 对本进程谎报「不存在」，而盘上那份竞态者的密钥是真的 —— 这正是落败进程眼中的世界。
// ============================================================

const hooks = vi.hoisted(() => ({
  /** 返回 boolean 覆盖 existsSync 的结果；返回 undefined 则走真实实现。 */
  existsOverride: null as null | ((path: string) => boolean | undefined),
  /** 每次 writeFileSync 落盘**当下**（任何后续 chmod 之前）观察到的模式。 */
  writes: [] as Array<{ path: string; modeAtWrite: number }>,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (p: string) => {
      const override = hooks.existsOverride?.(String(p))
      return override ?? actual.existsSync(p)
    },
    writeFileSync: (p: string, c: unknown, o?: unknown) => {
      const result = (actual.writeFileSync as (...a: unknown[]) => unknown)(p, c, o)
      hooks.writes.push({ path: String(p), modeAtWrite: actual.statSync(String(p)).mode & 0o777 })
      return result
    },
  }
})

const { getOrCreateKey } = await import('../../src/config/credential-crypto')

describe('getOrCreateKey — 竞态与权限', () => {
  let dir: string
  let keyPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mipham-credkey-'))
    keyPath = join(dir, '.cred-key')
    hooks.existsOverride = null
    hooks.writes = []
  })

  afterEach(() => {
    hooks.existsOverride = null
    hooks.writes = []
    rmSync(dir, { recursive: true, force: true })
  })

  it('与另一个进程竞态：不覆盖它已落盘的密钥，改用它的那一把', () => {
    const winner = randomBytes(32)
    writeFileSync(keyPath, winner)
    // 缝隙：本进程此刻仍以为文件不存在，而竞态者已经写完了。
    hooks.existsOverride = (p) => (p === keyPath ? false : undefined)

    const key = getOrCreateKey(keyPath)

    // 两边必须拿到**同一把**钥匙；否则各自写下的密文对方都解不开，且毫无报错。
    expect(key.equals(winner)).toBe(true)
    expect(readFileSync(keyPath).equals(winner)).toBe(true)
  })

  it('密钥落盘的那一刻就已经是 0400：不存在「先松后紧」的崩溃窗口', () => {
    getOrCreateKey(keyPath)

    // 判据取**写入当下**的模式，不取函数返回后的模式 —— 后者由事后 chmod 补上，
    // 恰好看不见崩在中间的那次。
    const write = hooks.writes.find((w) => w.path === keyPath)
    expect(write?.modeAtWrite).toBe(0o400)
  })

  it('已存在的松散权限密钥，在读取路径上被收紧', () => {
    writeFileSync(keyPath, randomBytes(32))
    chmodSync(keyPath, 0o644)
    expect(statSync(keyPath).mode & 0o777).toBe(0o644)

    getOrCreateKey(keyPath)

    // 读取路径原先直接 return，从不看权限 ⇒ 一份 0644 的密钥永久停在 0644。
    expect(statSync(keyPath).mode & 0o777).toBe(0o400)
  })

  it('新建的密钥目录不留同目录可读的口子（0700）', () => {
    const nested = join(dir, 'fresh', 'sub')
    getOrCreateKey(join(nested, '.cred-key'))

    expect(statSync(join(dir, 'fresh')).mode & 0o777).toBe(0o700)
    expect(statSync(nested).mode & 0o777).toBe(0o700)
  })
})
