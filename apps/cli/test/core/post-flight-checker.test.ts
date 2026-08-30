import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PostFlightChecker,
  createDefaultPostFlightChecker,
} from '../../src/core/post-flight-checker'

const dirs: string[] = []
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mipham-postflight-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('PostFlightChecker', () => {
  it('returns no-checker for an unregistered tool (silent, non-blocking)', () => {
    const c = createDefaultPostFlightChecker()
    expect(c.check('Grep', { params: {}, result: { success: true, content: '' } })).toEqual({
      verdict: 'no-checker',
    })
  })

  it('bash-exit: exit 0 → supported, exit non-0 → rejected', () => {
    const c = createDefaultPostFlightChecker()
    expect(c.check('Bash', { params: {}, result: { success: true, content: 'ok' } })).toEqual({
      verdict: 'supported',
      checkerId: 'bash-exit',
    })
    const rejected = c.check('Bash', {
      params: {},
      result: { success: false, content: '', error: 'Exit code 1' },
    })
    expect(rejected.verdict).toBe('rejected')
    expect((rejected as { checkerId: string }).checkerId).toBe('bash-exit')
  })

  it('write-exists: 文件存在且长度一致 → supported', () => {
    const dir = tmpDir()
    const p = join(dir, 'a.txt')
    const content = 'hello world'
    writeFileSync(p, content, 'utf-8')
    const c = createDefaultPostFlightChecker()
    expect(
      c.check('Write', {
        params: { file_path: p, content },
        result: { success: true, content: '' },
      }),
    ).toEqual({ verdict: 'supported', checkerId: 'write-exists' })
  })

  it('write-exists: 文件不存在 → rejected', () => {
    const dir = tmpDir()
    const c = createDefaultPostFlightChecker()
    const r = c.check('Write', {
      params: { file_path: join(dir, 'missing.txt'), content: 'x' },
      result: { success: true, content: '' },
    })
    expect(r.verdict).toBe('rejected')
  })

  it('write-exists: 长度不一致 → rejected', () => {
    const dir = tmpDir()
    const p = join(dir, 'b.txt')
    writeFileSync(p, 'short', 'utf-8')
    const c = createDefaultPostFlightChecker()
    const r = c.check('Write', {
      params: { file_path: p, content: 'much longer content' },
      result: { success: true, content: '' },
    })
    expect(r.verdict).toBe('rejected')
  })

  it('edit-applied: new_string 已生效 → supported', () => {
    const dir = tmpDir()
    const p = join(dir, 'c.txt')
    writeFileSync(p, 'replaced', 'utf-8')
    const c = createDefaultPostFlightChecker()
    expect(
      c.check('Edit', {
        params: { file_path: p, old_string: 'before', new_string: 'replaced' },
        result: { success: true, content: '' },
      }),
    ).toEqual({ verdict: 'supported', checkerId: 'edit-applied' })
  })

  it('edit-applied: old_string 仍残留（未生效）→ rejected', () => {
    const dir = tmpDir()
    const p = join(dir, 'd.txt')
    writeFileSync(p, 'before remains', 'utf-8')
    const c = createDefaultPostFlightChecker()
    const r = c.check('Edit', {
      params: { file_path: p, old_string: 'before', new_string: 'after' },
      result: { success: true, content: '' },
    })
    expect(r.verdict).toBe('rejected')
  })

  it('register overrides the default checker for a tool', () => {
    const c = new PostFlightChecker()
    c.register('always-true', 'Bash', () => true)
    expect(c.check('Bash', { params: {}, result: { success: false, content: '' } })).toEqual({
      verdict: 'supported',
      checkerId: 'always-true',
    })
  })
})
