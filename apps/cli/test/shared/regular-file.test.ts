/**
 * `isRegularFile` / `readRegularFileSync` —— 闸门架在文件**类型**上，不是存在性上。
 *
 * 本文件只测**不会阻塞**的形状（缺失、普通文件、目录、符号链接、FIFO 的 stat）。
 * 「FIFO 上的读取」有意不在这里断言：`readFileSync` 读没有写者的 FIFO 是**同步**
 * 阻塞，回归时整个 vitest worker 会僵住 —— 套件不会红，只会不动，而这正是
 * shared/regular-file.ts 要消灭的那个现象。那条判据跑在子进程里，见
 * `test/config/config-fifo.test.ts`。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRegularFile, readRegularFileSync } from '../../src/shared/regular-file'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mipham-regular-file-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 真建一个 FIFO —— 不用 mock：要防的正是真内核对象上的真阻塞。 */
function mkfifo(path: string): void {
  execFileSync('mkfifo', [path])
}

describe('isRegularFile', () => {
  it('普通文件为真', () => {
    const p = join(dir, 'config.yml')
    writeFileSync(p, 'providers: []\n')
    expect(isRegularFile(p)).toBe(true)
  })

  it('缺失为假', () => {
    expect(isRegularFile(join(dir, 'nope.yml'))).toBe(false)
  })

  it('目录为假', () => {
    const d = join(dir, 'adir')
    mkdirSync(d)
    // `existsSync` 对目录为真 —— 这正是它当不了闸门的原因。
    expect(isRegularFile(d)).toBe(false)
    expect(readRegularFileSync(d)).toBeNull()
  })

  it('符号链接指向普通文件为真（statSync 跟随链接）', () => {
    const target = join(dir, 'real.yml')
    writeFileSync(target, 'providers: []\n')
    const link = join(dir, 'link.yml')
    symlinkSync(target, link)
    expect(isRegularFile(link)).toBe(true)
    expect(readRegularFileSync(link)).toBe('providers: []\n')
  })

  it('FIFO 为假（statSync 本身不阻塞，所以这条可以在进程内跑）', () => {
    const p = join(dir, 'fifo.yml')
    mkfifo(p)
    expect(statSync(p).isFIFO()).toBe(true)
    expect(isRegularFile(p)).toBe(false)
  })

  it('符号链接指向 FIFO 为假', () => {
    const fifo = join(dir, 'real-fifo.yml')
    mkfifo(fifo)
    const link = join(dir, 'link-to-fifo.yml')
    symlinkSync(fifo, link)
    expect(isRegularFile(link)).toBe(false)
  })
})

describe('readRegularFileSync', () => {
  it('读普通文件返回内容', () => {
    const p = join(dir, 'prefs.json')
    writeFileSync(p, '{"a":"b"}')
    expect(readRegularFileSync(p)).toBe('{"a":"b"}')
  })

  it('缺失返回 null', () => {
    expect(readRegularFileSync(join(dir, 'nope.json'))).toBeNull()
  })

  it('空文件返回空串（不是 null —— 空文件是普通文件）', () => {
    const p = join(dir, 'empty.json')
    writeFileSync(p, '')
    expect(readRegularFileSync(p)).toBe('')
  })
})
