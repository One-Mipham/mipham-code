import { describe, it, expect } from 'vitest'
import { isRecoverableToolFailure } from '../../src/agent/recoverable-failure.js'

describe('isRecoverableToolFailure', () => {
  it('timeout is recoverable (environmental)', () => {
    expect(isRecoverableToolFailure('Bash', 'Command timed out after 30000ms')).toBe(true)
  })

  it('connection failure is recoverable (service down)', () => {
    expect(isRecoverableToolFailure('Bash', 'connect ECONNREFUSED 127.0.0.1:8080')).toBe(true)
  })

  it('missing file is recoverable (absent resource)', () => {
    expect(isRecoverableToolFailure('Bash', 'No such file or directory')).toBe(true)
  })

  it('permission denied is recoverable (environmental)', () => {
    expect(isRecoverableToolFailure('Bash', 'Permission denied (os error 13)')).toBe(true)
  })

  it('syntax error is a genuine defect, not recoverable', () => {
    expect(isRecoverableToolFailure('Bash', 'syntax error near unexpected token')).toBe(false)
  })

  it('invented binary is a genuine model error, not recoverable', () => {
    expect(isRecoverableToolFailure('Bash', 'command not found: nonexistent-tool')).toBe(false)
  })

  it('no error message fails closed (treated as genuine failure)', () => {
    expect(isRecoverableToolFailure('Bash', undefined)).toBe(false)
  })
})
