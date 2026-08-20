import { describe, it, expect, afterEach } from 'vitest'
import type { ToolDefinition } from '../../src/shared'
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
    expect(ps.getMode()).toBe('dontAsk') // clamped to highest allowed
  })

  it('honors env mode when restrictions allow it', () => {
    process.env[ENV_KEY] = 'auto'
    const ps = buildDaemonPermission({ forbiddenModes: ['bypassPermissions'] })
    expect(ps.getMode()).toBe('auto')
  })

  it('wires allow/deny rules into the permission system', () => {
    process.env[ENV_KEY] = 'auto'
    const ps = buildDaemonPermission(undefined, {
      deny: ['Read(**/.ssh/id_rsa)'],
      allow: ['Read'],
    })
    const readTool = makeTool('Read')
    // deny rule blocks a sensitive read even in auto mode (deny wins before mode baseline)
    expect(ps.needsApproval(readTool, { file_path: '/home/u/.ssh/id_rsa' })).toBe(true)
    // allow rule (and auto-mode baseline) permits a normal read
    expect(ps.isBypassed(readTool, { file_path: '/home/u/app.ts' })).toBe(true)
  })
})
