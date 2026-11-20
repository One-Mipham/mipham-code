/**
 * 输入诊断日志（`MIPHAM_DEBUG_INPUT=1`）的判据。
 *
 * 这份日志存在的唯一目的是把「冻结」切成两种可行动的故障：按键没送达 / 送达但没
 * 渲染。所以测试钉的是**它能不能区分**，不是格式好看：计数窗口、无事件不写空行、
 * 不把用户文本写进日志。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createInputDebug, describeKey } from '../../src/ui/input-debug'

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'mipham-input-debug-')), 'input-debug.log')
}

const lines = (f: string): string[] => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)

describe('describeKey：只记类别，不记内容', () => {
  it('可打印文本只报长度', () => {
    expect(describeKey('secret-token', {})).toBe('text:12')
    expect(describeKey('secret-token', {})).not.toContain('secret')
  })

  it('控制键报名字', () => {
    expect(describeKey('c', { ctrl: true })).toBe('ctrl:c')
    expect(describeKey('\r', { return: true })).toBe('return')
    expect(describeKey('\x1b', { escape: true })).toBe('escape')
  })

  it('不可打印的原始序列只报长度', () => {
    expect(describeKey('\x1b[200~', {})).toBe('raw:6')
  })
})

describe('createInputDebug', () => {
  it('写一行启动标记，便于区分是哪一次进程', () => {
    const f = tempFile()
    createInputDebug({ filePath: f, pid: 4242, now: () => 0 })
    expect(lines(f)[0]).toContain('start pid=4242')
  })

  it('flush 写出本窗口的 keys / renders 计数', () => {
    const f = tempFile()
    const d = createInputDebug({ filePath: f, pid: 1, now: () => 0 })
    d.recordKey('ab', {})
    d.recordRender()
    d.recordRender()
    d.flush()

    const last = lines(f).at(-1)!
    expect(last).toContain('keys=1')
    expect(last).toContain('renders=2')
    expect(last).toContain('bytes=2')
    expect(last).toContain('last=text:2')
  })

  it('没有新事件时不写空行（空闲的进程不该把日志填满）', () => {
    const f = tempFile()
    const d = createInputDebug({ filePath: f, pid: 1, now: () => 0 })
    d.recordKey('a', {})
    d.flush()
    const before = lines(f).length
    d.flush()
    d.flush()
    expect(lines(f).length).toBe(before)
  })

  it('计数按窗口清零（第二行只含第二个窗口的事件）', () => {
    const f = tempFile()
    const d = createInputDebug({ filePath: f, pid: 1, now: () => 0 })
    d.recordKey('a', {})
    d.flush()
    d.recordKey('b', {})
    d.flush()

    const all = lines(f).filter((l) => l.includes('keys='))
    expect(all).toHaveLength(2)
    expect(all[0]).toContain('keys=1')
    expect(all[1]).toContain('keys=1')
  })
})

describe('开关：未开启时不产生任何文件与副作用', () => {
  it('getInputDebug() 在 MIPHAM_DEBUG_INPUT 未设置 / 非 "1" 时返回 null', async () => {
    vi.resetModules()
    delete process.env.MIPHAM_DEBUG_INPUT
    const mod = await import('../../src/ui/input-debug')
    expect(mod.getInputDebug()).toBeNull()

    vi.resetModules()
    process.env.MIPHAM_DEBUG_INPUT = '0'
    const mod2 = await import('../../src/ui/input-debug')
    expect(mod2.getInputDebug()).toBeNull()
    delete process.env.MIPHAM_DEBUG_INPUT
  })
})
