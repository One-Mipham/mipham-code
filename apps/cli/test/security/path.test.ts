import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveSafe } from '../../src/security/path'

describe('resolveSafe', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mipham-sec-path-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('normal paths', () => {
    it('resolves a relative path within cwd', () => {
      mkdirSync(join(tmpDir, 'src'), { recursive: true })
      writeFileSync(join(tmpDir, 'src', 'app.ts'), '// hello')
      const result = resolveSafe(tmpDir, 'src/app.ts')
      expect(result).toContain('src/app.ts')
    })

    it('resolves "." to cwd', () => {
      const result = resolveSafe(tmpDir, '.')
      // On macOS, /var is a symlink to /private/var, so use endsWith
      expect(result.endsWith(tmpDir.replace(/^\/private/, '')) || result === tmpDir).toBe(true)
    })

    it('resolves nested subdirectories', () => {
      mkdirSync(join(tmpDir, 'a', 'b', 'c'), { recursive: true })
      writeFileSync(join(tmpDir, 'a', 'b', 'c', 'deep.ts'), '// deep')
      const result = resolveSafe(tmpDir, 'a/b/c/deep.ts')
      expect(result).toContain('a/b/c/deep.ts')
    })
  })

  describe('path traversal attacks', () => {
    it('rejects "../" escape attempts', () => {
      expect(() => resolveSafe(tmpDir, '../../../etc/passwd')).toThrow(
        'outside the project workspace',
      )
    })

    it('rejects absolute system paths', () => {
      expect(() => resolveSafe(tmpDir, '/etc/hosts')).toThrow(
        'outside the project workspace',
      )
    })

    it('rejects /etc/passwd', () => {
      expect(() => resolveSafe(tmpDir, '/etc/passwd')).toThrow(
        'outside the project workspace',
      )
    })

    it('rejects /proc/self/environ', () => {
      expect(() => resolveSafe(tmpDir, '/proc/self/environ')).toThrow(
        /outside|protected/,
      )
    })
  })

  describe('symlink attacks', () => {
    it('rejects symlinks pointing outside workspace', () => {
      // Create a symlink inside workspace pointing to /etc
      symlinkSync('/etc', join(tmpDir, 'link-to-etc'))
      expect(() => resolveSafe(tmpDir, 'link-to-etc')).toThrow(
        /outside|protected/,
      )
    })

    it('allows symlinks within workspace', () => {
      mkdirSync(join(tmpDir, 'real-dir'), { recursive: true })
      writeFileSync(join(tmpDir, 'real-dir', 'file.ts'), '// ok')
      symlinkSync(join(tmpDir, 'real-dir'), join(tmpDir, 'link-dir'))

      const result = resolveSafe(tmpDir, 'link-dir/file.ts')
      expect(result).toContain('file.ts')
    })
  })

  describe('non-existent paths (write/create scenario)', () => {
    it('allows new file path within workspace', () => {
      const result = resolveSafe(tmpDir, 'new-folder/new-file.ts')
      expect(result).toContain('new-folder/new-file.ts')
    })

    it('rejects new file path outside workspace', () => {
      expect(() => resolveSafe(tmpDir, '../../../tmp/hack.ts')).toThrow(
        'outside the project workspace',
      )
    })
  })
})
