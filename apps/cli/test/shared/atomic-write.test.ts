import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ============================================================
// 原子写的临时名必须**每个写者一把**。
//
// `path + '.tmp'` 是固定的一处名字，而这个函数的调用者里有若干**全局共享**的落点：
// 遥测队列（每个进程退出时写一次）、skill 用量、CRSI 台账。同机并发的两个会话
// （或 CLI 与 daemon worker）会撞在同一把临时名上：
//   A 写 tmp → B 写 tmp → A rename 把 **B 的内容**搬成目标文件 → B rename ENOENT。
// 也就是说，这个函数号称「读者永远看不到半截」，却在真实并发下丢更新、还抛异常。
//
// 同步 fs 调用在单进程里没法真并发，所以用**嵌套调用**造出那个交错：写者 A 的
// writeFileSync 挂上钩子，在 A 尚未 rename 时把写者 B 整趟跑完。这正是两个进程
// 交错时真实发生的顺序。
// ============================================================

const hooks = vi.hoisted(() => ({
  onWrite: null as null | ((path: string, content: string) => void),
  onRename: null as null | ((from: string, to: string) => void),
  renameSources: [] as string[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (p: string, c: unknown, o?: unknown) => {
      const result = (actual.writeFileSync as (...a: unknown[]) => unknown)(p, c, o)
      hooks.onWrite?.(String(p), String(c))
      return result
    },
    renameSync: (from: string, to: string) => {
      hooks.onRename?.(from, to)
      hooks.renameSources.push(from)
      ;(actual.renameSync as (...a: unknown[]) => void)(from, to)
    },
  }
})

const { atomicWriteFileSync } = await import('../../src/shared/atomic-write')

describe('atomicWriteFileSync', () => {
  let dir: string
  let target: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mipham-atomic-'))
    target = join(dir, 'queue.jsonl')
    hooks.onWrite = null
    hooks.onRename = null
    hooks.renameSources = []
  })

  afterEach(() => {
    hooks.onWrite = null
    hooks.onRename = null
    rmSync(dir, { recursive: true, force: true })
  })

  const tmpLeftovers = () => readdirSync(dir).filter((f) => f.endsWith('.tmp'))

  it('正常写入：内容落盘，且不留下临时文件', () => {
    atomicWriteFileSync(target, 'hello')

    expect(readFileSync(target, 'utf-8')).toBe('hello')
    expect(tmpLeftovers()).toEqual([])
  })

  it('每个写者一把临时名（顺序两次写也不同名）', () => {
    atomicWriteFileSync(target, 'first')
    atomicWriteFileSync(target, 'second')

    expect(hooks.renameSources).toHaveLength(2)
    expect(hooks.renameSources[0]).not.toBe(hooks.renameSources[1])
    expect(hooks.renameSources).not.toContain(`${target}.tmp`)
  })

  it('两个写者交错：谁都不抛异常，目标文件也不会被搬错内容', () => {
    // 写者 A 写完自己的临时文件后，在它 rename 之前，让写者 B 整趟跑完。
    hooks.onWrite = (_p, content) => {
      if (content !== 'A') return
      hooks.onWrite = null
      atomicWriteFileSync(target, 'B')
    }

    expect(() => atomicWriteFileSync(target, 'A')).not.toThrow()

    // 目标文件必须是**某一整个**写者的内容，不能是拼起来的、也不能是空。
    expect(['A', 'B']).toContain(readFileSync(target, 'utf-8'))
    expect(tmpLeftovers()).toEqual([])
  })

  it('rename 失败时不留下孤儿临时文件', () => {
    hooks.onRename = () => {
      throw new Error('boom')
    }

    expect(() => atomicWriteFileSync(target, 'x')).toThrow('boom')

    expect(tmpLeftovers()).toEqual([])
  })
})
