/**
 * CC 2.1.329-202 / 2.1.330-051:
 * - Read must not report a line the file does not contain (files ending `\n`).
 * - Grep must report a rejected pattern instead of guessing "permission denied".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReadTool } from '../../src/tools/file/read'
import type { ToolContext } from '../../src/shared'

let dir: string

function ctx(): ToolContext {
  return { cwd: dir, sessionId: 'edge-test', provider: 'test', model: 'test-model' }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mipham-read-grep-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('Read — 行数等于文件真实行数', () => {
  it('以换行结尾的文件不多报一行空白', async () => {
    const file = join(dir, 'trailing.txt')
    writeFileSync(file, 'a\nb\n')
    const result = await createReadTool().execute({ file_path: file }, ctx())
    expect(result.success).toBe(true)
    // 两行就是两行：没有 `     3\t` 这一行。
    expect(result.content).toContain('     1\ta')
    expect(result.content).toContain('     2\tb')
    expect(result.content).not.toContain('\n     3\t')
  })

  it('文件内部的空行仍然保留', async () => {
    const file = join(dir, 'inner-blank.txt')
    writeFileSync(file, 'a\n\n')
    const result = await createReadTool().execute({ file_path: file }, ctx())
    expect(result.success).toBe(true)
    // "a\n\n" 有两行：`a` 和一个空行。
    expect(result.content).toContain('     1\ta')
    expect(result.content).toContain('     2\t')
    expect(result.content).not.toContain('\n     3\t')
  })

  it('空文件不报一行空行', async () => {
    const file = join(dir, 'empty.txt')
    writeFileSync(file, '')
    const result = await createReadTool().execute({ file_path: file }, ctx())
    expect(result.success).toBe(true)
    expect(result.content.trim()).toBe('')
  })
})
