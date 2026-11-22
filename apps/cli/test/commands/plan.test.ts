import { describe, it, expect } from 'vitest'
import { PermissionSystem } from '../../src/core/permission'
import { getCommand } from '../../src/ui/commands'

/**
 * `/plan` 是「直接进计划模式」的快捷方式。它曾只把一句提示转发给模型
 * （让模型去调 EnterPlanMode）——模型不配合时，模式根本没变。
 */
function makeCtx(perm: PermissionSystem, canSwitch = true) {
  const setPermissionMode = (mode: Parameters<PermissionSystem['setMode']>[0]): void => {
    perm.setMode(mode)
  }
  return {
    engine: {
      getPermission: () => perm,
      getContext: () => ({ getMessages: () => [] }),
      getTools: () => new Map(),
    },
    config: { permission: perm.getMode(), providers: [] },
    t: (k: string) => k,
    ...(canSwitch ? { setPermissionMode } : {}),
  } as unknown as Parameters<NonNullable<ReturnType<typeof getCommand>>>[0]
}

describe('/plan', () => {
  it('从 default 直接切到 plan（不靠模型配合）', async () => {
    const perm = new PermissionSystem('default')
    const result = await getCommand('/plan')!(makeCtx(perm), [])
    expect(perm.getMode()).toBe('plan')
    expect(result.content).toContain('Plan mode on')
  })

  it('已在 plan 时幂等，不重复告警', async () => {
    const perm = new PermissionSystem('plan')
    const result = await getCommand('/plan')!(makeCtx(perm), [])
    expect(perm.getMode()).toBe('plan')
    expect(result.content).not.toContain('Plan mode on')
  })

  it('无 setPermissionMode 的界面如实说不能切，而不是假装已进入', async () => {
    const perm = new PermissionSystem('default')
    const result = await getCommand('/plan')!(makeCtx(perm, false), [])
    expect(perm.getMode()).toBe('default')
    expect(result.content).toContain('cannot switch permission modes')
  })
})
