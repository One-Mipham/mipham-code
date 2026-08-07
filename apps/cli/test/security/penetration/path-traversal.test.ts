import { describe, it, expect } from 'vitest'
import { SecurityGate } from '../../../src/security/gate'

describe('path traversal detection', () => {
  const cwd = '/home/user/project'

  it('blocks ".." traversal', () => {
    const result = SecurityGate.checkPathTraversal('../../../etc/passwd', cwd)
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('..')
  })

  it('blocks null byte injection', () => {
    const result = SecurityGate.checkPathTraversal('file.txt\0/etc/passwd', cwd)
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('null byte')
  })

  it('blocks double-encoded traversal (%2e%2e)', () => {
    const result = SecurityGate.checkPathTraversal('%2e%2e/%2e%2e/etc/passwd', cwd)
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('double-encoded')
  })

  it('allows normal relative paths', () => {
    const result = SecurityGate.checkPathTraversal('src/utils/helper.ts', cwd)
    expect(result.blocked).toBe(false)
  })

  it('allows empty path', () => {
    const result = SecurityGate.checkPathTraversal('', cwd)
    expect(result.blocked).toBe(false)
  })
})
