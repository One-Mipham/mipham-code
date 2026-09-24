import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isDeletedCwdError,
  deletedCwdMessage,
  deletedCwdSessionMessage,
  resolveExistingCwd,
} from '../../src/shared/deleted-cwd'

describe('isDeletedCwdError', () => {
  it('detects a Node-style uv_cwd ENOENT', () => {
    const err = new Error('ENOENT: no such file or directory, uv_cwd')
    ;(err as NodeJS.ErrnoException).code = 'ENOENT'
    expect(isDeletedCwdError(err)).toBe(true)
  })

  it('detects a runtime that omits the ENOENT code but names getcwd', () => {
    const err = new Error('getcwd() failed')
    expect(isDeletedCwdError(err)).toBe(true)
  })

  it('rejects a non-Error value', () => {
    expect(isDeletedCwdError('ENOENT: something')).toBe(false)
    expect(isDeletedCwdError(undefined)).toBe(false)
    expect(isDeletedCwdError(null)).toBe(false)
  })

  it('rejects an unrelated ENOENT-less error', () => {
    const err = new Error('some other failure')
    ;(err as NodeJS.ErrnoException).code = 'EACCES'
    expect(isDeletedCwdError(err)).toBe(false)
  })
})

describe('deletedCwdMessage', () => {
  it('tells the user to change directory and retry', () => {
    const msg = deletedCwdMessage()
    expect(msg).toContain('no longer exists')
    expect(msg).toContain('Change to a valid directory')
    expect(msg).toContain('mipham')
  })
})

describe('resolveExistingCwd', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a directory that exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mipham-live-'))
    try {
      expect(resolveExistingCwd(dir)).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Measured, not assumed: the two runtimes report a deleted working directory
  // differently, and only one of them reports it at all.
  it('reports gone when the runtime hands back a cached path (Bun)', () => {
    // Bun does not throw — with the launch directory deleted, `process.cwd()`
    // returns the path it cached at startup. The directory is gone either way.
    vi.spyOn(process, 'cwd').mockReturnValue(join(tmpdir(), 'mipham-gone-cached'))
    expect(resolveExistingCwd()).toBeNull()
  })

  it('reports gone when the runtime throws ENOENT (Node)', () => {
    const err: NodeJS.ErrnoException = new Error(
      'ENOENT: process.cwd failed with error no such file or directory, ' +
        'the current working directory was likely removed without changing the ' +
        'working directory, uv_cwd',
    )
    err.code = 'ENOENT'
    err.syscall = 'uv_cwd'
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw err
    })
    expect(resolveExistingCwd()).toBeNull()
  })

  it('lets an unrelated failure through instead of calling it a deleted directory', () => {
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => resolveExistingCwd()).toThrow('boom')
  })

  it('checks the directory it was given, not the process cwd', () => {
    const alive = mkdtempSync(join(tmpdir(), 'mipham-live-'))
    try {
      expect(resolveExistingCwd(join(alive, 'missing-subdir'))).toBeNull()
      expect(resolveExistingCwd(join(alive, 'missing-subdir'))).not.toBe(process.cwd())
    } finally {
      rmSync(alive, { recursive: true, force: true })
    }
  })
})

describe('deletedCwdSessionMessage', () => {
  it('describes a session that lost its directory mid-run', () => {
    const msg = deletedCwdSessionMessage()
    expect(msg).toContain('no longer exists')
    expect(msg).toContain('restarted from a directory that exists')
    // The startup phrasing tells the reader to launch the CLI; this one is read
    // from inside a running session, so it must not.
    expect(msg).not.toContain("can't start")
  })
})
