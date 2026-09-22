import { describe, it, expect, afterEach } from 'vitest'
import type { PermissionRestrictions, ToolDefinition } from '../../src/shared'
import { buildDaemonPermission } from '../../src/daemon/server'

const ENV_KEY = 'MIPHAM_DAEMON_PERMISSION'

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    category: 'file',
    permission: 'self',
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
    // Clamped to the **widest** allowed mode below the requested one. 这条断言改过
    // 两次，两次都只是因为层级表里「夹在中间的那一档」变了：plan ⇒ acceptEdits
    // ⇒ **auto**（auto 已插到 acceptEdits 与 bypassPermissions 之间，即 CC 的排序）。
    // 方向仍然是收窄（auto ⊂ bypass），见 test/core/permission.test.ts 的完整论证。
    //
    // ⚠️ **对 daemon 而言这一档今天是「全拒」**：daemon 还没有分类器（Step 5/6），
    // 而 auto 的静态基线恒为 'ask' ⇒ 每个工具调用都被拒。这是 fail-closed，
    // 不是提权 —— 但「运维把 bypass 写进 MIPHAM_DAEMON_PERMISSION、又在
    // restrictions 里禁掉 bypass」这个组合，从「静默放行一切」变成「一个都不做」，
    // 服务的可观测表现是任务全失败。接线分类器之前，这段组合必须被知道。
    expect(ps.getMode()).toBe('auto')
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
