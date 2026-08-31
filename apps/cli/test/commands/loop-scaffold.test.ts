import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scaffoldLoopKit } from '../../src/commands/loop-scaffold'
import { loadHookConfigs } from '../../src/core/hooks-config'

describe('scaffoldLoopKit settings.json', () => {
  let base: string

  beforeEach(() => {
    base = join(
      tmpdir(),
      'mipham-loop-scaffold-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    )
    mkdirSync(base, { recursive: true })
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('generates settings.json and does NOT generate the legacy hooks/*.sh dir', () => {
    scaffoldLoopKit(base)
    expect(existsSync(join(base, '.mipham', 'settings.json'))).toBe(true)
    expect(existsSync(join(base, '.mipham', 'hooks'))).toBe(false)
  })

  it('emits a real PreToolUse hook template (not an empty array)', () => {
    scaffoldLoopKit(base)
    const parsed = JSON.parse(readFileSync(join(base, '.mipham', 'settings.json'), 'utf-8')) as {
      permissions: { allow: unknown[]; deny: unknown[] }
      hooks: {
        PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>
      }
    }
    expect(parsed.permissions).toEqual({ allow: [], deny: [] })
    expect(parsed.hooks.PreToolUse).toHaveLength(1)
    expect(parsed.hooks.PreToolUse[0]!.matcher).toBe('Bash')
    expect(parsed.hooks.PreToolUse[0]!.hooks[0]!.type).toBe('command')
  })

  it('the emitted hooks load into HookDefinitions via loadHookConfigs', () => {
    scaffoldLoopKit(base)
    const parsed = JSON.parse(readFileSync(join(base, '.mipham', 'settings.json'), 'utf-8'))
    const defs = loadHookConfigs(parsed.hooks)
    expect(defs).toHaveLength(1)
    expect(defs[0]!.event).toBe('PreToolUse')
  })
})
