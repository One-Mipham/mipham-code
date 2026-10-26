import { describe, it, expect } from 'vitest'
import { PermissionSystem } from '../../src/core/permission'
import { getCommand } from '../../src/ui/commands'

/**
 * `ExitPlanMode` prints "The user can approve by saying \"approved\" or
 * \"/approve\"". That sentence is a contract with the user, and until `/approve`
 * existed it had no landing point — the unknown-command path swallowed it and the
 * session stayed in `plan` while the model read the approval as prose.
 *
 * The command must also refuse everywhere else: every non-plan mode is either
 * already wider than what approval grants, or has no plan pending, so honouring a
 * stray `/approve` there would be a permission escalation.
 */
function makeCtx(perm: PermissionSystem) {
  const setPermissionMode = (mode: Parameters<PermissionSystem['setMode']>[0]): void => {
    perm.setMode(mode)
  }
  return {
    ctx: {
      engine: {
        getPermission: () => perm,
        getContext: () => ({ getMessages: () => [] }),
        getTools: () => new Map(),
      },
      config: { permission: perm.getMode(), providers: [] },
      t: (k: string) => k,
      setPermissionMode,
    } as unknown as Parameters<NonNullable<ReturnType<typeof getCommand>>>[0],
    perm,
  }
}

describe('/approve', () => {
  it('is registered (the ExitPlanMode result names it)', () => {
    expect(getCommand('/approve')).toBeTruthy()
  })

  it('switches plan → acceptEdits', async () => {
    const perm = new PermissionSystem('plan')
    const { ctx } = makeCtx(perm)
    const { content } = await getCommand('/approve')!(ctx, [])
    expect(perm.getMode()).toBe('acceptEdits')
    expect(content).toContain('Plan approved')
  })

  it.each(['default', 'acceptEdits', 'auto', 'bypassPermissions'] as const)(
    'refuses outside plan mode (%s) and leaves the mode alone',
    async (mode) => {
      const perm = new PermissionSystem(mode)
      const { ctx } = makeCtx(perm)
      const { content } = await getCommand('/approve')!(ctx, [])
      expect(perm.getMode()).toBe(mode)
      expect(content).toContain('not in plan mode')
    },
  )

  it('says so when the surface cannot switch modes', async () => {
    const perm = new PermissionSystem('plan')
    const { ctx } = makeCtx(perm)
    delete (ctx as { setPermissionMode?: unknown }).setPermissionMode
    const { content } = await getCommand('/approve')!(ctx, [])
    expect(perm.getMode()).toBe('plan')
    expect(content).toContain('cannot switch permission modes')
  })
})
