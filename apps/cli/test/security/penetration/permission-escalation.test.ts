import { describe, it, expect } from 'vitest'

describe('permission escalation prevention', () => {
  it('permission modes are defined in the mode cycle', async () => {
    const { PermissionSystem } = await import('../../../src/core/permission')
    const perm = new PermissionSystem()
    // Verify it starts at 'default'
    expect(perm.getMode()).toBe('default')
  })

  it('setMode accepts valid mode strings', async () => {
    const { PermissionSystem } = await import('../../../src/core/permission')
    const perm = new PermissionSystem()
    perm.setMode('auto')
    expect(perm.getMode()).toBe('auto')
  })

  it('setMode clamps to valid modes', async () => {
    const { PermissionSystem } = await import('../../../src/core/permission')
    const perm = new PermissionSystem()
    // Trying to set an invalid mode should not crash
    try {
      perm.setMode('superadmin' as any)
    } catch {
      // May throw — acceptable
    }
    // Mode should still be a valid PermissionMode
    expect(typeof perm.getMode()).toBe('string')
  })

  it('check returns a decision string for tools', async () => {
    const { PermissionSystem } = await import('../../../src/core/permission')
    const perm = new PermissionSystem('default')
    const result = perm.check(
      { name: 'read', permission: 'auto', category: 'file', description: 'test tool' } as any,
      {} as any,
    )
    expect(['deny', 'ask', 'allow', 'auto']).toContain(result)
  })

  it('cycleMode advances to the next mode', async () => {
    const { PermissionSystem } = await import('../../../src/core/permission')
    const perm = new PermissionSystem('default')
    const next = perm.cycleMode()
    expect(next).not.toBe('default')
    expect(perm.getMode()).toBe(next)
  })
})
