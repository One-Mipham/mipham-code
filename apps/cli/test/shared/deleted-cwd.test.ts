import { describe, it, expect } from 'vitest'
import { isDeletedCwdError, deletedCwdMessage } from '../../src/shared/deleted-cwd'

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
