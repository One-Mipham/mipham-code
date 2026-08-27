import { describe, it, expect } from 'vitest'
import { isRecoverableToolFailure } from '../../src/agent/recoverable-failure.js'

describe('isRecoverableToolFailure', () => {
  it('timeout is recoverable (environmental)', () => {
    expect(isRecoverableToolFailure('Command timed out after 30000ms')).toBe(true)
  })

  it('connection refused is recoverable (service down)', () => {
    expect(isRecoverableToolFailure('connect ECONNREFUSED 127.0.0.1:8080')).toBe(true)
  })

  it('DNS resolution failure is recoverable', () => {
    expect(isRecoverableToolFailure('Could not resolve host api.example.com')).toBe(true)
  })

  it('ETIMEDOUT is recoverable', () => {
    expect(isRecoverableToolFailure('connect ETIMEDOUT 10.0.0.1:443')).toBe(true)
  })

  it('permission denied is recoverable (environmental)', () => {
    expect(isRecoverableToolFailure('Permission denied (os error 13)')).toBe(true)
  })

  it('missing file (ENOENT) is a genuine defect, not recoverable', () => {
    // 2026-08-27 M1: 缺文件/路径错是规则指错路径（幻觉），非环境瞬态，须计入分母。
    expect(isRecoverableToolFailure('No such file or directory')).toBe(false)
  })

  it('syntax error is a genuine defect, not recoverable', () => {
    expect(isRecoverableToolFailure('syntax error near unexpected token')).toBe(false)
  })

  it('invented binary is a genuine model error, not recoverable', () => {
    expect(isRecoverableToolFailure('command not found: nonexistent-tool')).toBe(false)
  })

  it('no error message fails closed (treated as genuine failure)', () => {
    expect(isRecoverableToolFailure(undefined)).toBe(false)
  })
})
