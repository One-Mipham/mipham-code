import { describe, it, expect, afterEach } from 'vitest'
import type { PermissionRestrictions, ToolDefinition } from '../../src/shared'
import { buildDaemonPermission } from '../../src/daemon/server'

const ENV_KEY = 'MIPHAM_DAEMON_PERMISSION'

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    category: 'file',
    permission: 'auto',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ success: true, content: '' }),
  }
}

afterEach(() => {
  delete process.env[ENV_KEY]
})

describe('buildDaemonPermission', () => {
  it('defaults to least-privilege default when env is unset', () => {
    delete process.env[ENV_KEY]
    expect(buildDaemonPermission().getMode()).toBe('default')
  })

  it('downgrades bypassPermissions when forbidden by restrictions', () => {
    process.env[ENV_KEY] = 'bypassPermissions'
    const ps = buildDaemonPermission({ forbiddenModes: ['bypassPermissions'] })
    // Clamped to the **widest** allowed mode below the requested one —— acceptEdits，
    // 不是 plan。旧断言写的是 plan，读的是旧的层级表（plan 排在 acceptEdits 之上）
    // ⇒ 把宽严判反了：降级反而落到比 acceptEdits **更窄**的一档。见 permission-config.ts。
    expect(ps.getMode()).toBe('acceptEdits')
  })

  it('honors env mode when restrictions allow it', () => {
    process.env[ENV_KEY] = 'acceptEdits'
    const ps = buildDaemonPermission({ forbiddenModes: ['bypassPermissions'] })
    expect(ps.getMode()).toBe('acceptEdits')
  })

  it('写错的 restrictions 不再静默失效：钉到最严一档并留下告警（P1 · daemon 通道）', () => {
    process.env[ENV_KEY] = 'bypassPermissions'
    const ps = buildDaemonPermission({
      maxAllowedMode: 'acceptedit',
    } as unknown as PermissionRestrictions)

    expect(ps.getMode()).toBe('plan')
    expect(ps.getInvalidRestrictions().join('\n')).toContain('acceptedit')
  })

  it('wires allow/deny rules into the permission system', () => {
    process.env[ENV_KEY] = 'default'
    const ps = buildDaemonPermission(undefined, {
      deny: ['Read(**/.ssh/id_rsa)'],
      allow: ['Read'],
    })
    const readTool = makeTool('Read')
    // deny rule blocks a sensitive read (deny wins before mode baseline)
    expect(ps.needsApproval(readTool, { file_path: '/home/u/.ssh/id_rsa' })).toBe(true)
    // allow rule permits a normal read
    expect(ps.isBypassed(readTool, { file_path: '/home/u/app.ts' })).toBe(true)
  })
})
