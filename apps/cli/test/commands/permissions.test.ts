import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Isolate from the real ~/.mipham — /permissions also reads user settings.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-permissions` }
})

import { rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PermissionSystem } from '../../src/core/permission'
import { permissionsCmd } from '../../src/commands/project'
import type { ToolDefinition } from '../../src/shared'

const CWD = join(homedir(), 'proj')
const settingsPath = join(CWD, '.mipham', 'settings.json')

const writeTool: ToolDefinition = {
  name: 'Write',
  description: 'Write a file',
  category: 'file',
  permission: 'ask',
  parameters: { type: 'object', properties: {} },
  async execute() {
    return { success: true, content: '' }
  },
}

/**
 * C4 (方案甲): `/permissions allow <rule>` is the explicit persistence point
 * for "always allow". These tests pin that it (a) lands in settings.json,
 * (b) takes effect in the live permission system, not just on next start, and
 * (c) refuses a rule that could never match.
 */
describe('/permissions — rule persistence', () => {
  let perm: PermissionSystem

  function makeCtx() {
    return {
      engine: {
        getPermission: () => perm,
        getContext: () => ({ getMessages: () => [] }),
        getTools: () => new Map(),
      },
      t: (k: string) => k,
    } as unknown as Parameters<typeof permissionsCmd>[0]
  }

  beforeEach(() => {
    rmSync(homedir(), { recursive: true, force: true })
    mkdirSync(join(CWD, '.mipham'), { recursive: true })
    // The command resolves the project scope from process.cwd().
    vi.spyOn(process, 'cwd').mockReturnValue(CWD)
    perm = new PermissionSystem('plan')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(homedir(), { recursive: true, force: true })
  })

  it('writes an allow rule to settings.json', async () => {
    await permissionsCmd(makeCtx(), ['allow', 'Write'])
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.allow).toEqual(['Write'])
  })

  it('takes effect in the live session, not only after restart', async () => {
    // plan mode denies writes by baseline.
    expect(perm.check(writeTool, {})).toBe('ask')
    await permissionsCmd(makeCtx(), ['allow', 'Write'])
    expect(perm.check(writeTool, {})).toBe('bypass')
  })

  it('writes a deny rule and blocks in the live session', async () => {
    await permissionsCmd(makeCtx(), ['deny', 'Write'])
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.deny).toEqual(['Write'])
    expect(perm.check(writeTool, {})).toBe('ask')
  })

  it('rejects a malformed rule without writing anything', async () => {
    const result = await permissionsCmd(makeCtx(), ['allow', 'Write('])
    expect(result.content).toContain('Invalid rule')
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('rejects an empty rule', async () => {
    const result = await permissionsCmd(makeCtx(), ['allow'])
    expect(result.content).toContain('Missing rule')
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('removes a persisted rule', async () => {
    await permissionsCmd(makeCtx(), ['allow', 'Write'])
    await permissionsCmd(makeCtx(), ['remove', 'Write'])
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).permissions.allow).toEqual([])
    expect(perm.check(writeTool, {})).toBe('ask')
  })

  it('reports when there is nothing to remove', async () => {
    const result = await permissionsCmd(makeCtx(), ['remove', 'Write'])
    expect(result.content).toContain('No rule')
  })

  it('lists persisted rules in the status view', async () => {
    await permissionsCmd(makeCtx(), ['allow', 'Write'])
    const result = await permissionsCmd(makeCtx(), [])
    expect(result.content).toContain('Write')
    expect(result.content).toContain('/permissions allow')
  })
})
