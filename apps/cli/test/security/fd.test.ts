import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
  closeSync,
  constants,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openNoFollow, isSymlinkLoop, writeFileNoFollow } from '../../src/security/fd'

describe('security/fd — O_NOFOLLOW primitives (TOCTOU symlink guard)', () => {
  let tmpDir: string
  let target: string
  let link: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mipham-fd-'))
    target = join(tmpDir, 'target.txt')
    link = join(tmpDir, 'link.txt')
    writeFileSync(target, 'secret')
    symlinkSync(target, link)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('openNoFollow opens a regular file', () => {
    const fd = openNoFollow(target, constants.O_RDONLY)
    closeSync(fd)
    expect(fd).toBeGreaterThanOrEqual(0)
  })

  it('openNoFollow rejects a symlink with ELOOP', () => {
    let code: string | undefined
    try {
      const fd = openNoFollow(link, constants.O_RDONLY)
      closeSync(fd)
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code
    }
    expect(code).toBe('ELOOP')
  })

  it('isSymlinkLoop detects ELOOP', () => {
    expect(isSymlinkLoop({ code: 'ELOOP' })).toBe(true)
    expect(isSymlinkLoop({ code: 'ENOENT' })).toBe(false)
    expect(isSymlinkLoop(new Error('nope'))).toBe(false)
  })

  it('writeFileNoFollow writes to a regular file', () => {
    writeFileNoFollow(target, 'overwritten', constants.O_WRONLY | constants.O_TRUNC)
    expect(readFileSync(target, 'utf-8')).toBe('overwritten')
  })

  it('writeFileNoFollow refuses to write through a symlink (fail closed)', () => {
    let threw = false
    try {
      writeFileNoFollow(link, 'pwned', constants.O_WRONLY | constants.O_TRUNC)
    } catch (err) {
      threw = isSymlinkLoop(err)
    }
    expect(threw).toBe(true)
    // The symlink target is untouched — the write did not follow the link.
    expect(readFileSync(target, 'utf-8')).toBe('secret')
  })
})
